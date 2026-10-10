import { Connection, Keypair, PublicKey, Transaction, type ConfirmOptions } from '@solana/web3.js'
import {
  BN,
  BulkAccountLoader,
  DriftClient,
  FastSingleTxSender,
  MarketType,
  PerpMarkets,
  PositionDirection,
  QUOTE_PRECISION,
  SpotMarkets,
  TokenFaucet,
  Wallet,
  getMarketOrderParams,
  getUserAccountPublicKey,
  type DriftEnv,
  type TxSigAndSlot,
} from '@drift-labs/sdk'
import { getAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { config } from '../config'
import { getChainContext } from './registry'
import { base58Decode } from '../core/base58'
import { solanaConnection } from './personaSolana'

// ============================================================
// Drift Protocol 永续合约(Solana 家族,defi-perp-drift 技能用)
// SDK @drift-labs/sdk 2.151.0:DriftClient 负责组交易 + 热钱包签名,
// 发送/确认经 FailoverTxSender 路由到 solanaConnection(devnet RPC 慢/抖,
// 发送失败重试同签名幂等)。devnet 保证金 = SDK SpotMarkets['devnet'] 的
// USDC 现货市场(mint 8zGuJQ...,与链配置里的 Circle devnet USDC 不同);
// 该 mint 的 mint authority 是 Drift 官方 token faucet 程序的 PDA
// (程序 V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB,经 SDK TokenFaucet 领取)。
// Drift 程序 devnet 与 mainnet 同地址(dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH)。
// ⚠ 已知链侧问题(2026-10 实测):devnet 该程序为未发布分支构建(user.rs:694 /
// orders.rs:158,与任何 tag/master/devnet 分支均不符),无法解析链上现货/永续
// 市场账户(任意市场 deposit 报 SpotMarketNotFound 6087、下单报
// PerpMarketNotFound 6078,手工构造 ix 亦复现),官方 devnet 应用
// drift-devnet.vercel.app 已下线。faucet 铸币与用户账户初始化不受影响。
// ============================================================

/** Drift 程序地址(devnet 与 mainnet 官方部署同地址) */
export const DRIFT_PROGRAM_ID = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH'

/** Drift devnet token faucet 程序(SDK idl/token_faucet 对应的官方部署,mint authority 已核实) */
export const DRIFT_FAUCET_PROGRAM_ID = 'V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB'

/** 默认使用的永续/现货市场索引(SOL-PERP / USDC 保证金) */
export const DRIFT_QUOTE_SPOT_MARKET_INDEX = 0
export const DRIFT_SOL_PERP_MARKET_INDEX = 0

/** 提取 Drift/anchor 错误里的可读信息(program logs 通常包含真实原因) */
function describeDriftError(e: unknown): string {
  if (e instanceof Error) {
    const logs = (e as { logs?: string[] }).logs
    if (logs && logs.length > 0) return `${e.message} | logs: ${logs.slice(-3).join(' ; ')}`
    return e.message
  }
  return String(e)
}

/**
 * 把 SDK 交易发送路由到 solanaConnection 故障转移连接:
 * 继承 FastSingleTxSender 的组交易/签名逻辑,只重写 sendRawTransaction,
 * 发送 + 确认走 FailoverConnection,失败退避重发(同签名幂等,不会双花)。
 */
class FailoverTxSender extends FastSingleTxSender {
  constructor(
    private readonly chainKey: string,
    connection: Connection,
    wallet: Wallet,
    opts: ConfirmOptions,
  ) {
    super({ connection, wallet, opts, blockhashRefreshInterval: 0 })
  }

  override async sendRawTransaction(rawTransaction: Buffer | Uint8Array, _opts?: ConfirmOptions): Promise<TxSigAndSlot> {
    const conn = solanaConnection(this.chainKey)
    const raw = rawTransaction instanceof Buffer ? rawTransaction : Buffer.from(rawTransaction)
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const txSig = await conn.sendRawTransaction(raw)
        await conn.confirmTransaction(txSig)
        return { txSig, slot: 0 }
      } catch (e) {
        lastErr = e
        if (attempt < 4) await new Promise((r) => setTimeout(r, 2000 * attempt))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
}

export interface DriftHandle {
  client: DriftClient
  wallet: Keypair
  readConn: Connection
  env: DriftEnv
}

const handles = new Map<string, Promise<DriftHandle>>()

function hotWallet(): Keypair {
  const secret = config.agentSolanaKey
  if (!secret) throw new Error('未配置 AGENT_SOLANA_PRIVATE_KEY')
  return Keypair.fromSecretKey(base58Decode(secret))
}

/** 技能可用前提:配置了热钱包私钥 */
export function isDriftConfigured(): boolean {
  return Boolean(config.agentSolanaKey)
}

/** 指定 env 的 Drift 保证金 USDC(mint 与现货市场索引,来自 SDK 官方配置) */
export function driftQuoteSpotMarket(env: DriftEnv): { marketIndex: number; mint: string; symbol: string } {
  const market = (SpotMarkets[env] ?? []).find((m) => m.symbol === 'USDC')
  if (!market) throw new Error(`[drift] SDK 配置中找不到 ${env} 的 USDC 现货市场`)
  return { marketIndex: market.marketIndex, mint: market.mint.toBase58(), symbol: market.symbol }
}

/** 列出 env 下全部永续市场(symbol → marketIndex) */
export function driftPerpMarkets(env: DriftEnv): { symbol: string; marketIndex: number }[] {
  return (PerpMarkets[env] ?? []).map((m) => ({ symbol: m.symbol, marketIndex: m.marketIndex }))
}

/** 惰性构建并按 chainKey 缓存的 DriftClient(websocket 订阅;失败回落轮询) */
export function driftHandle(chainKey: string): Promise<DriftHandle> {
  let h = handles.get(chainKey)
  if (!h) {
    h = buildDriftHandle(chainKey)
    handles.set(chainKey, h)
    h.catch(() => handles.delete(chainKey)) // 构建失败不缓存,下次重试
  }
  return h
}

async function buildDriftHandle(chainKey: string): Promise<DriftHandle> {
  const ctx = getChainContext(chainKey)
  const env: DriftEnv = ctx.cfg.chainId === 103 ? 'devnet' : 'mainnet-beta'
  const readConn = new Connection(ctx.cfg.rpc, 'confirmed')
  const keypair = hotWallet()
  const wallet = new Wallet(keypair)
  const opts: ConfirmOptions = { commitment: 'confirmed' }

  // 先尝试 websocket 订阅;devnet 官方 wss 不可达时回落到轮询加载器
  try {
    const client = new DriftClient({
      connection: readConn,
      wallet,
      env,
      programID: new PublicKey(DRIFT_PROGRAM_ID),
      accountSubscription: { type: 'websocket' },
      txSender: new FailoverTxSender(chainKey, readConn, wallet, opts),
      opts,
    })
    await client.subscribe()
    return { client, wallet: keypair, readConn, env }
  } catch (e) {
    const loader = new BulkAccountLoader(readConn, 'confirmed', 2000)
    loader.startPolling()
    const client = new DriftClient({
      connection: readConn,
      wallet,
      env,
      programID: new PublicKey(DRIFT_PROGRAM_ID),
      accountSubscription: { type: 'polling', accountLoader: loader },
      txSender: new FailoverTxSender(chainKey, readConn, wallet, opts),
      opts,
    })
    await client.subscribe()
    return { client, wallet: keypair, readConn, env }
  }
}

/** 当前 env 下按名称解析永续市场索引(unknown → 报错并列出可用市场) */
export function resolvePerpMarketIndex(env: DriftEnv, market: string): number {
  const normalized = market.trim().toUpperCase()
  const hit = (PerpMarkets[env] ?? []).find((m) => m.symbol === normalized)
  if (!hit) {
    const available = driftPerpMarkets(env)
      .map((m) => m.symbol)
      .join(', ')
    throw new Error(`未知永续市场 "${market}"(可用: ${available})`)
  }
  return hit.marketIndex
}

/** 用户账户(subAccount 0)是否存在 */
async function driftUserAccountExists(handle: DriftHandle): Promise<boolean> {
  const userPda = await getUserAccountPublicKey(new PublicKey(DRIFT_PROGRAM_ID), handle.wallet.publicKey, 0)
  const acc = await handle.readConn.getAccountInfo(userPda)
  return Boolean(acc)
}

/**
 * 确保 Drift 用户账户(subAccount 0)存在:不存在则 initializeUserAccount 并确认,
 * 随后把 User 挂进 client。其余写操作都必须先调本函数。
 */
export async function ensureDriftUser(chainKey: string): Promise<{ initialized: boolean; signature?: string }> {
  const handle = await driftHandle(chainKey)
  if (await driftUserAccountExists(handle)) {
    if (!handle.client.hasUser(0, handle.wallet.publicKey)) await handle.client.addUser(0)
    return { initialized: false }
  }
  const [signature] = await handle.client.initializeUserAccount(0)
  await handle.client.addUser(0)
  return { initialized: true, signature }
}

/** 发送一笔手工组的热钱包交易,经 FailoverConnection 发送 + 确认,带重试 */
async function sendManualTx(chainKey: string, readConn: Connection, tx: Transaction, wallet: Keypair): Promise<string> {
  const conn = solanaConnection(chainKey)
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await readConn.getLatestBlockhash('confirmed')
      tx.recentBlockhash = blockhash
      tx.lastValidBlockHeight = lastValidBlockHeight
      tx.feePayer = wallet.publicKey
      tx.sign(wallet)
      const signature = await conn.sendRawTransaction(tx.serialize())
      await conn.confirmTransaction(signature)
      return signature
    } catch (e) {
      lastErr = e
      if (attempt < 4) await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 存入保证金(USDC 原子单位):确保 ATA 存在后 DriftClient.deposit */
export async function driftDeposit(chainKey: string, usdcAtomic: bigint): Promise<string> {
  if (usdcAtomic <= 0n) throw new Error('存入金额必须大于 0')
  const handle = await driftHandle(chainKey)
  await ensureDriftUser(chainKey)
  const { marketIndex, mint } = driftQuoteSpotMarket(handle.env)
  const market = handle.client.getSpotMarketAccount(marketIndex)
  const tokenProgram = market ? handle.client.getTokenProgramForSpotMarket(market) : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), handle.wallet.publicKey, true, tokenProgram)
  if (!(await handle.readConn.getAccountInfo(ata))) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        handle.wallet.publicKey,
        ata,
        handle.wallet.publicKey,
        new PublicKey(mint),
        tokenProgram,
      ),
    )
    await sendManualTx(chainKey, handle.readConn, tx, handle.wallet)
  }
  try {
    return await handle.client.deposit(new BN(usdcAtomic.toString()), marketIndex, ata, 0)
  } catch (e) {
    throw new Error(describeDriftError(e))
  }
}

/** 提取保证金(USDC 原子单位)到热钱包 ATA */
export async function driftWithdraw(chainKey: string, usdcAtomic: bigint): Promise<string> {
  if (usdcAtomic <= 0n) throw new Error('提取金额必须大于 0')
  const handle = await driftHandle(chainKey)
  await ensureDriftUser(chainKey)
  const { marketIndex, mint } = driftQuoteSpotMarket(handle.env)
  const market = handle.client.getSpotMarketAccount(marketIndex)
  const tokenProgram = market ? handle.client.getTokenProgramForSpotMarket(market) : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), handle.wallet.publicKey, true, tokenProgram)
  try {
    return await handle.client.withdraw(new BN(usdcAtomic.toString()), marketIndex, ata, false, 0)
  } catch (e) {
    throw new Error(describeDriftError(e))
  }
}

/** 指定永续市场的预言机价格(美元,PRICE_PRECISION=1e6 定点),用于 USD 名义额 → base 数量换算 */
export async function driftOraclePriceUsd(chainKey: string, marketIndex: number): Promise<number> {
  const handle = await driftHandle(chainKey)
  const oracle = handle.client.getOracleDataForPerpMarket(marketIndex)
  if (!oracle) throw new Error(`[drift] 拿不到市场 ${marketIndex} 的预言机价格`)
  return oracle.price.toNumber() / 1e6
}

/** USD 名义额 → base 原子数量(BASE_PRECISION=1e9),按市场预言机价格 */
export async function driftCalcBaseAmount(chainKey: string, marketIndex: number, usdNotional: number): Promise<bigint> {
  if (usdNotional <= 0) throw new Error('名义额必须大于 0')
  const priceUsd = await driftOraclePriceUsd(chainKey, marketIndex)
  if (priceUsd <= 0) throw new Error(`[drift] 市场 ${marketIndex} 预言机价格异常: ${priceUsd}`)
  return BigInt(Math.round((usdNotional / priceUsd) * 1e9))
}

/** 市价开多/开空(只开仓;已有反向持仓时 Drift 会按净头寸成交) */
export async function driftOpenPosition(
  chainKey: string,
  marketIndex: number,
  side: 'long' | 'short',
  sizeBaseAtomic: bigint,
): Promise<string> {
  if (sizeBaseAtomic <= 0n) throw new Error('仓位数量必须大于 0')
  const handle = await driftHandle(chainKey)
  await ensureDriftUser(chainKey)
  const orderParams = getMarketOrderParams({
    marketIndex,
    marketType: MarketType.PERP,
    direction: side === 'long' ? PositionDirection.LONG : PositionDirection.SHORT,
    baseAssetAmount: new BN(sizeBaseAtomic.toString()),
  })
  try {
    return await handle.client.placePerpOrder(orderParams)
  } catch (e) {
    throw new Error(describeDriftError(e))
  }
}

/** 市价平仓(reduce-only):按当前持仓数量反向成交到归零 */
export async function driftClosePosition(chainKey: string, marketIndex: number): Promise<string> {
  const handle = await driftHandle(chainKey)
  await ensureDriftUser(chainKey)
  const user = handle.client.getUser(0, handle.wallet.publicKey)
  const position = user.getPerpPosition(marketIndex)
  const base = position?.baseAssetAmount
  if (!base || base.isZero()) throw new Error(`市场 ${marketIndex} 没有可平持仓`)
  const orderParams = getMarketOrderParams({
    marketIndex,
    marketType: MarketType.PERP,
    direction: base.isNeg() ? PositionDirection.LONG : PositionDirection.SHORT,
    baseAssetAmount: base.abs(),
    reduceOnly: true,
  })
  try {
    return await handle.client.placePerpOrder(orderParams)
  } catch (e) {
    throw new Error(describeDriftError(e))
  }
}

export interface DriftPerpPositionInfo {
  market: string
  marketIndex: number
  side: 'long' | 'short'
  base: string // base 人类单位(BASE_PRECISION=1e9)
  entryPrice: string // 美元
  pnl: string // 美元(未实现,含资金费)
}

export interface DriftStatus {
  collateral: string // 总保证金(美元)
  freeCollateral: string // 可用保证金(美元)
  buyingPower: string // SOL-PERP 购买力(base 人类单位)
  positions: DriftPerpPositionInfo[]
}

/** 账户状态:保证金/可用保证金/购买力 + 未平永续持仓 */
export async function driftStatus(chainKey: string): Promise<DriftStatus> {
  const handle = await driftHandle(chainKey)
  await ensureDriftUser(chainKey)
  const user = handle.client.getUser(0, handle.wallet.publicKey)
  const collateral = user.getTotalCollateral().toNumber() / QUOTE_PRECISION.toNumber()
  const freeCollateral = user.getFreeCollateral().toNumber() / QUOTE_PRECISION.toNumber()
  const buyingPower = user.getPerpBuyingPower(DRIFT_SOL_PERP_MARKET_INDEX).toNumber() / 1e9

  const positions: DriftPerpPositionInfo[] = []
  for (const p of user.getUserAccount().perpPositions) {
    if (p.baseAssetAmount.isZero() && p.openOrders === 0 && p.lpShares.isZero()) continue
    const market = (PerpMarkets[handle.env] ?? []).find((m) => m.marketIndex === p.marketIndex)
    const baseHuman = p.baseAssetAmount.toNumber() / 1e9
    const side: 'long' | 'short' = p.baseAssetAmount.isNeg() ? 'short' : 'long'
    const entryPrice =
      !p.baseAssetAmount.isZero() && !p.quoteEntryAmount.isZero()
        ? ((p.quoteEntryAmount.abs().toNumber() / 1e6) / Math.abs(baseHuman)).toFixed(4)
        : '0'
    let pnlUsd = '0'
    try {
      pnlUsd = (user.getUnrealizedPNL(true, p.marketIndex).toNumber() / 1e6).toFixed(4)
    } catch {
      // 预言机数据暂缺时留 0
    }
    positions.push({
      market: market?.symbol ?? `PERP-${p.marketIndex}`,
      marketIndex: p.marketIndex,
      side,
      base: Math.abs(baseHuman).toFixed(6),
      entryPrice,
      pnl: pnlUsd,
    })
  }
  return { collateral: collateral.toFixed(4), freeCollateral: freeCollateral.toFixed(4), buyingPower: buyingPower.toFixed(4), positions }
}

/**
 * 经 Drift 官方 devnet token faucet 铸造保证金 USDC 到热钱包
 * (程序 V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB,SDK TokenFaucet 组 ix,
 * 热钱包签名,发送/确认走 FailoverConnection)。仅 devnet 有意义。
 */
export async function driftFaucetUsdc(chainKey: string, usdcAtomic: bigint): Promise<{ signature: string; ata: string }> {
  if (usdcAtomic <= 0n) throw new Error('铸造金额必须大于 0')
  const handle = await driftHandle(chainKey)
  if (handle.env !== 'devnet') throw new Error('faucet 只在 devnet 可用')
  const { mint } = driftQuoteSpotMarket(handle.env)
  const faucet = new TokenFaucet(
    handle.readConn,
    new Wallet(handle.wallet),
    new PublicKey(DRIFT_FAUCET_PROGRAM_ID),
    new PublicKey(mint),
  )
  const [ata, createIx, mintIx] = await faucet.createAssociatedTokenAccountAndMintToInstructions(
    handle.wallet.publicKey,
    new BN(usdcAtomic.toString()),
  )
  const tx = new Transaction()
  if (!(await handle.readConn.getAccountInfo(ata))) tx.add(createIx)
  tx.add(mintIx)
  const signature = await sendManualTx(chainKey, handle.readConn, tx, handle.wallet)
  return { signature, ata: ata.toBase58() }
}

/** 热钱包当前保证金 USDC 余额(原子单位;ATA 不存在返回 0) */
export async function driftQuoteTokenBalance(chainKey: string): Promise<bigint> {
  const handle = await driftHandle(chainKey)
  const { marketIndex, mint } = driftQuoteSpotMarket(handle.env)
  const market = handle.client.getSpotMarketAccount(marketIndex)
  const tokenProgram = market ? handle.client.getTokenProgramForSpotMarket(market) : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), handle.wallet.publicKey, true, tokenProgram)
  const acc = await handle.readConn.getAccountInfo(ata)
  if (!acc) return 0n
  const token = await getAccount(handle.readConn, ata)
  return BigInt(token.amount.toString())
}
