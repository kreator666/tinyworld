import { Connection, Keypair, PublicKey, Transaction, type ConfirmOptions } from '@solana/web3.js'
import {
  BN,
  BulkAccountLoader,
  DelistedMarketSetting,
  DriftClient,
  FastSingleTxSender,
  MarketType,
  PerpMarkets,
  PositionDirection,
  QUOTE_PRECISION,
  SpotMarkets,
  Wallet,
  getMarketOrderParams,
  getUserAccountPublicKey,
  type DriftEnv,
  type TxSigAndSlot,
} from '@drift-labs/sdk'
import { getAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { config } from '../config'
import { base58Decode } from '../core/base58'
import { MAINNET_RPC, MAINNET_USDC_MINT, MAX_PERP_DEPOSIT_USDC, mainnetConnection } from './solanaExec'

// ============================================================
// Drift Protocol 永续合约(Solana 家族,defi-perp-drift 技能用)
// split-brain(见 chain/solanaExec.ts):身份/人格从请求链(solana-devnet)读取,
// 永续交易统一在 Solana 主网执行,小金额。SDK @drift-labs/sdk 2.156.0:
// DriftClient 负责组交易 + 热钱包签名,发送/确认经 FailoverTxSender 路由
// mainnetConnection()(主 RPC → 备用,重试同签名幂等)。
// 保证金 = SDK SpotMarkets['mainnet-beta'] 的 USDC 现货市场(= 主网 Circle
// USDC EPjFWdd...,启动时校验);主网没有水龙头,入金前检查热钱包真实余额,
// 不足时提示先经 Meteora 兑换。单笔入金硬顶 MAX_PERP_DEPOSIT_USDC。
// Drift 程序 devnet 与 mainnet 同地址(dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH)。
// ⚠ 链侧现状(2026-10 实测):dRiftyHA39... 主网部署已事实下线——自 2026-09-25 起
// 该程序拒绝【所有】用户交易(InstructionFallbackNotFound 101,非本仓库问题,
// 公共 SDK 2.151/2.156/2.163 均如此),10-07 后无任何交易;Drift 已迁移至
// Velocity(新程序 vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P,闭源,
// 见 docs.velocity.exchange)。本模块读路径(行情/状态)仍可用,写路径在链侧
// 重新可用(或接入 Velocity)后无需改动即可工作。
// 历史备注:devnet 官方部署更早损坏(程序拒绝解析自己的市场账户,官方 devnet
// 应用已下线);DRIFT_ENV 保留为模块级常量以便将来重指。
// ============================================================

/** Drift 程序地址(devnet 与 mainnet 官方部署同地址) */
export const DRIFT_PROGRAM_ID = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH'

/** Drift SDK 环境:执行层固定主网(改动此处即可整体重指,如链侧恢复后回 devnet) */
const DRIFT_ENV: DriftEnv = 'mainnet-beta'

/** 默认使用的永续/现货市场索引(SOL-PERP / USDC 保证金,主网实测索引 0) */
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
 * 把 SDK 交易发送路由到主网故障转移连接:
 * 继承 FastSingleTxSender 的组交易/签名逻辑,只重写 sendRawTransaction,
 * 发送 + 确认走 mainnetConnection,失败退避重发(同签名幂等,不会双花)。
 */
class FailoverTxSender extends FastSingleTxSender {
  constructor(connection: Connection, wallet: Wallet, opts: ConfirmOptions) {
    super({ connection, wallet, opts, blockhashRefreshInterval: 0 })
  }

  override async sendRawTransaction(rawTransaction: Buffer | Uint8Array, _opts?: ConfirmOptions): Promise<TxSigAndSlot> {
    const conn = mainnetConnection()
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

let handlePromise: Promise<DriftHandle> | null = null

function hotWallet(): Keypair {
  const secret = config.agentSolanaKey
  if (!secret) throw new Error('未配置 AGENT_SOLANA_PRIVATE_KEY')
  return Keypair.fromSecretKey(base58Decode(secret))
}

/** 技能可用前提:配置了热钱包私钥(主网热钱包) */
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

/** 惰性构建并缓存的 DriftClient(固定主网;websocket 订阅,失败回落轮询) */
export function driftHandle(): Promise<DriftHandle> {
  if (!handlePromise) {
    handlePromise = buildDriftHandle()
    handlePromise.catch(() => (handlePromise = null)) // 构建失败不缓存,下次重试
  }
  return handlePromise
}

async function buildDriftHandle(): Promise<DriftHandle> {
  const env = DRIFT_ENV
  const readConn = new Connection(MAINNET_RPC, 'confirmed')
  const keypair = hotWallet()
  const wallet = new Wallet(keypair)
  const opts: ConfirmOptions = { commitment: 'confirmed' }

  // 保证金 mint 与执行层主网 USDC 一致性校验(漂移时告警,不阻断)
  const quote = driftQuoteSpotMarket(env)
  if (quote.mint !== MAINNET_USDC_MINT) {
    console.warn(`[drift] 警告:SDK ${env} 保证金 mint ${quote.mint} ≠ 执行层 MAINNET_USDC_MINT ${MAINNET_USDC_MINT}`)
  }

  // 显式声明市场索引:新 SDK 在缺省时会对全量市场做 gPA 扫描(findAllMarketAndOracles),
  // 主网上有旧版 fulfillment/market 账户会让 IDL union 解码崩掉;而全量静态索引又会在
  // 公共 RPC 上触发 429 且踩 SDK 已下架市场退订 bug。只订阅我们交易的保证金市场(0)与
  // SOL-PERP(0):足够 deposit/open/close/status 全链路,也最省 RPC 配额。
  // 若要开其他市场,把对应索引加进这里(或改服务器 env 用私有 RPC 后再扩成全量)。
  const perpMarketIndexes = [DRIFT_SOL_PERP_MARKET_INDEX]
  const spotMarketIndexes = [DRIFT_QUOTE_SPOT_MARKET_INDEX]

  // 先尝试 websocket 订阅;公共主网 RPC 的 wss 不可达时回落到轮询加载器
  try {
    const client = new DriftClient({
      connection: readConn,
      wallet,
      env,
      programID: new PublicKey(DRIFT_PROGRAM_ID),
      perpMarketIndexes,
      spotMarketIndexes,
      accountSubscription: { type: 'websocket' },
      delistedMarketSetting: DelistedMarketSetting.Subscribe, // 缺省 Unsubscribe 会对静态配置里链上不存在/已下架的市场调 .get().unsubscribe() 崩掉(SDK bug),我们不交易那些市场,保持订阅即可
      txSender: new FailoverTxSender(readConn, wallet, opts),
      opts,
    })
    await client.subscribe()
    return { client, wallet: keypair, readConn, env }
  } catch {
    const loader = new BulkAccountLoader(readConn, 'confirmed', 2000)
    loader.startPolling()
    const client = new DriftClient({
      connection: readConn,
      wallet,
      env,
      programID: new PublicKey(DRIFT_PROGRAM_ID),
      perpMarketIndexes,
      spotMarketIndexes,
      accountSubscription: { type: 'polling', accountLoader: loader },
      delistedMarketSetting: DelistedMarketSetting.Subscribe,
      txSender: new FailoverTxSender(readConn, wallet, opts),
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
export async function ensureDriftUser(): Promise<{ initialized: boolean; signature?: string }> {
  const handle = await driftHandle()
  if (await driftUserAccountExists(handle)) {
    if (!handle.client.hasUser(0, handle.wallet.publicKey)) await handle.client.addUser(0)
    return { initialized: false }
  }
  const [signature] = await handle.client.initializeUserAccount(0)
  await handle.client.addUser(0)
  return { initialized: true, signature }
}

/** 发送一笔手工组的热钱包交易,经主网 FailoverConnection 发送 + 确认,带重试 */
async function sendManualTx(readConn: Connection, tx: Transaction, wallet: Keypair): Promise<string> {
  const conn = mainnetConnection()
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

/** 保证金 USDC ATA(按现货市场的 token program 计算) */
async function quoteTokenAccount(handle: DriftHandle): Promise<PublicKey> {
  const { marketIndex, mint } = driftQuoteSpotMarket(handle.env)
  const market = handle.client.getSpotMarketAccount(marketIndex)
  const tokenProgram = market ? handle.client.getTokenProgramForSpotMarket(market) : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
  return getAssociatedTokenAddressSync(new PublicKey(mint), handle.wallet.publicKey, true, tokenProgram)
}

/**
 * 存入保证金(USDC 原子单位,主网真钱):硬顶 MAX_PERP_DEPOSIT_USDC/笔;
 * 主网无水龙头——热钱包余额不足时明确报错,提示先经 Meteora 兑换或人工充值;
 * ATA 不存在则幂等创建后 DriftClient.deposit。
 */
export async function driftDeposit(usdcAtomic: bigint): Promise<string> {
  if (usdcAtomic <= 0n) throw new Error('存入金额必须大于 0')
  const handle = await driftHandle()
  const capAtomic = BigInt(Math.round(MAX_PERP_DEPOSIT_USDC * 1e6))
  if (usdcAtomic > capAtomic) {
    throw new Error(`单笔入金上限 ${MAX_PERP_DEPOSIT_USDC} USDC(SOLANA_MAX_PERP_DEPOSIT_USDC 可调),请拆小金额`)
  }
  const balance = await driftQuoteTokenBalance()
  if (balance < usdcAtomic) {
    throw new Error(
      `主网热钱包 Drift 保证金 USDC 余额不足(需 ${Number(usdcAtomic) / 1e6}、有 ${Number(balance) / 1e6} USDC)。` +
        '主网没有水龙头:请先经 Meteora 兑换技能(SOL→USDC)或人工充值到热钱包后再入金。',
    )
  }
  await ensureDriftUser()
  const { marketIndex } = driftQuoteSpotMarket(handle.env)
  const ata = await quoteTokenAccount(handle)
  if (!(await handle.readConn.getAccountInfo(ata))) {
    const { mint } = driftQuoteSpotMarket(handle.env)
    const market = handle.client.getSpotMarketAccount(marketIndex)
    const tokenProgram = market ? handle.client.getTokenProgramForSpotMarket(market) : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(handle.wallet.publicKey, ata, handle.wallet.publicKey, new PublicKey(mint), tokenProgram),
    )
    await sendManualTx(handle.readConn, tx, handle.wallet)
  }
  try {
    return await handle.client.deposit(new BN(usdcAtomic.toString()), marketIndex, ata, 0)
  } catch (e) {
    throw new Error(describeDriftError(e))
  }
}

/** 提取保证金(USDC 原子单位)到热钱包 ATA(主网真钱) */
export async function driftWithdraw(usdcAtomic: bigint): Promise<string> {
  if (usdcAtomic <= 0n) throw new Error('提取金额必须大于 0')
  const handle = await driftHandle()
  await ensureDriftUser()
  const { marketIndex } = driftQuoteSpotMarket(handle.env)
  const ata = await quoteTokenAccount(handle)
  try {
    return await handle.client.withdraw(new BN(usdcAtomic.toString()), marketIndex, ata, false, 0)
  } catch (e) {
    throw new Error(describeDriftError(e))
  }
}

/** 指定永续市场的预言机价格(美元,PRICE_PRECISION=1e6 定点),用于 USD 名义额 → base 数量换算 */
export async function driftOraclePriceUsd(marketIndex: number): Promise<number> {
  const handle = await driftHandle()
  const oracle = handle.client.getOracleDataForPerpMarket(marketIndex)
  if (!oracle) throw new Error(`[drift] 拿不到市场 ${marketIndex} 的预言机价格`)
  return oracle.price.toNumber() / 1e6
}

/** USD 名义额 → base 原子数量(BASE_PRECISION=1e9),按市场预言机价格 */
export async function driftCalcBaseAmount(marketIndex: number, usdNotional: number): Promise<bigint> {
  if (usdNotional <= 0) throw new Error('名义额必须大于 0')
  const priceUsd = await driftOraclePriceUsd(marketIndex)
  if (priceUsd <= 0) throw new Error(`[drift] 市场 ${marketIndex} 预言机价格异常: ${priceUsd}`)
  return BigInt(Math.round((usdNotional / priceUsd) * 1e9))
}

/** 市价开多/开空(只开仓;已有反向持仓时 Drift 会按净头寸成交)。名义额硬顶在技能层校验 */
export async function driftOpenPosition(marketIndex: number, side: 'long' | 'short', sizeBaseAtomic: bigint): Promise<string> {
  if (sizeBaseAtomic <= 0n) throw new Error('仓位数量必须大于 0')
  const handle = await driftHandle()
  await ensureDriftUser()
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
export async function driftClosePosition(marketIndex: number): Promise<string> {
  const handle = await driftHandle()
  await ensureDriftUser()
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
export async function driftStatus(): Promise<DriftStatus> {
  const handle = await driftHandle()
  await ensureDriftUser()
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

/** 主网热钱包当前保证金 USDC 余额(原子单位;ATA 不存在返回 0) */
export async function driftQuoteTokenBalance(): Promise<bigint> {
  const handle = await driftHandle()
  const ata = await quoteTokenAccount(handle)
  const acc = await handle.readConn.getAccountInfo(ata)
  if (!acc) return 0n
  const token = await getAccount(handle.readConn, ata)
  return BigInt(token.amount.toString())
}
