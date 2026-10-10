import { Connection, Keypair, PublicKey, Transaction, type Cluster } from '@solana/web3.js'
import { LBCLMM, LBCLMM_PROGRAM_IDS } from '@meteora-ag/dlmm-sdk'
import BN from 'bn.js'
import { config } from '../config'
import { getChainContext } from './registry'
import { base58Decode } from '../core/base58'
import { solanaConnection } from './personaSolana'

// ============================================================
// Meteora DLMM 兑换(Solana 家族,defi-swap-meteora 技能用)
// devnet 上唯一真实可用的 DEX 程序(DLMM program LBUZKhRx...);
// SDK(@meteora-ag/dlmm-sdk 0.7.7)负责报价/组交易(含 wSOL wrap/unwrap、ATA 幂等创建),
// 本模块只做:池地址解析(可用 METEORA_POOL_ADDRESS 轮换)、热钱包签名、
// 经 FailoverConnection 发送并确认。
// 池创建/加流动性见 scripts/meteora-create-pool.cjs(devnet 预置池,见 DEFAULT_POOL_ADDRESS)。
// ============================================================

/** Meteora DLMM 程序地址(devnet 与 mainnet 同地址,官方部署) */
export const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'

/**
 * 我们已注入流动性的 devnet 池(WSOL/tUSDC,binStep=100,activeBinId=-162 ≈ 199.5 USDC/SOL)。
 * devnet 定期重置后须重建并用 METEORA_POOL_ADDRESS 指向新池(重建方法:scripts/meteora-create-pool.cjs);
 * 主网应通过环境变量覆盖为本方自有池。
 */
const DEFAULT_POOL_ADDRESS = 'CFqdEF2HGnXTbKyeUAX7oDUQojus9JHegfhj8y1T4gua'

/** 池地址(env METEORA_POOL_ADDRESS 优先;非法地址直接抛) */
export function meteoraPoolAddress(): PublicKey {
  return new PublicKey(process.env.METEORA_POOL_ADDRESS || DEFAULT_POOL_ADDRESS)
}

/** 技能可用前提:配置了热钱包私钥且池地址可解析 */
export function isMeteoraSwapConfigured(): boolean {
  if (!config.agentSolanaKey) return false
  try {
    meteoraPoolAddress()
    return true
  } catch {
    return false
  }
}

/** SDK 读路径用连接(主 RPC;发送/确认走 solanaConnection 故障转移) */
const readConns = new Map<string, Connection>()
function readConnection(chainKey: string): Connection {
  let conn = readConns.get(chainKey)
  if (!conn) {
    conn = new Connection(getChainContext(chainKey).cfg.rpc, 'confirmed')
    readConns.set(chainKey, conn)
  }
  return conn
}

function clusterOf(chainKey: string): Cluster {
  // 目前只服务 devnet;solana-devnet 的 chainId 103 为 devnet 哨兵
  const chainId = getChainContext(chainKey).cfg.chainId
  if (chainId === 103) return 'devnet'
  return 'mainnet-beta'
}

async function loadPair(chainKey: string): Promise<LBCLMM> {
  const conn = readConnection(chainKey)
  const [pair] = await LBCLMM.createMultiple(conn, [meteoraPoolAddress()], { cluster: clusterOf(chainKey) })
  if (!pair) throw new Error(`[${chainKey}] 无法加载 Meteora 池 ${meteoraPoolAddress().toBase58()}`)
  return pair
}

function hotWallet(): Keypair {
  const secret = config.agentSolanaKey
  if (!secret) throw new Error('未配置 AGENT_SOLANA_PRIVATE_KEY')
  return Keypair.fromSecretKey(base58Decode(secret))
}

export interface MeteoraQuote {
  outAmount: string
  poolId: string
}

/**
 * 报价:精确输入额的 swapQuote(exact-in)。
 * inputMint/outputMint 为 mint 地址(SOL 侧传 WSOL mint,SDK 内部处理 wrap/unwrap)。
 */
export async function quoteMeteoraSwap(
  chainKey: string,
  inputMint: string,
  outputMint: string,
  amountAtomic: bigint,
  slippageBps = 100,
): Promise<MeteoraQuote> {
  const pair = await loadPair(chainKey)
  const inMint = new PublicKey(inputMint)
  const outMint = new PublicKey(outputMint)
  const swapForY = inMint.equals(pair.tokenX.publicKey)
  if (!swapForY && !inMint.equals(pair.tokenY.publicKey)) {
    throw new Error(`Meteora 池不支持输入代币 ${inputMint}`)
  }
  if (swapForY && !outMint.equals(pair.tokenY.publicKey)) {
    throw new Error(`Meteora 池不支持输出代币 ${outputMint}`)
  }
  const binArrays = await pair.getBinArrays()
  const quote = pair.swapQuote(new BN(amountAtomic.toString()), swapForY, new BN(slippageBps), binArrays)
  return { outAmount: quote.outAmount.toString(), poolId: pair.pubkey.toBase58() }
}

/**
 * 执行兑换:SDK 组装交易(ATA 幂等创建 + wSOL wrap/unwrap + slippage 内 minOut),
 * 热钱包(feePayer + 唯一签名者)签名,经 FailoverConnection 发送并确认(带 fresh blockhash 重试,
 * 不 skipPreflight——模拟能拦住真实错误)。返回 base58 签名。
 */
export async function executeMeteoraSwap(
  chainKey: string,
  inputMint: string,
  outputMint: string,
  amountAtomic: bigint,
  slippageBps = 100,
): Promise<string> {
  const pair = await loadPair(chainKey)
  const wallet = hotWallet()
  const inMint = new PublicKey(inputMint)
  const outMint = new PublicKey(outputMint)
  const swapForY = inMint.equals(pair.tokenX.publicKey)
  if (!swapForY && !inMint.equals(pair.tokenY.publicKey)) {
    throw new Error(`Meteora 池不支持输入代币 ${inputMint}`)
  }

  const binArrays = await pair.getBinArrays()
  const quote = pair.swapQuote(new BN(amountAtomic.toString()), swapForY, new BN(slippageBps), binArrays)

  const tx: Transaction = await pair.swap({
    inToken: inMint,
    outToken: outMint,
    inAmount: new BN(amountAtomic.toString()),
    minOutAmount: quote.minOutAmount,
    lbPair: pair.pubkey,
    user: wallet.publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  })

  const conn = solanaConnection(chainKey)
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await readConnection(chainKey).getLatestBlockhash('confirmed')
      tx.recentBlockhash = blockhash
      tx.lastValidBlockHeight = lastValidBlockHeight
      tx.feePayer = wallet.publicKey
      tx.sign(wallet)
      const signature = await conn.sendRawTransaction(tx.serialize())
      await conn.confirmTransaction(signature)
      return signature
    } catch (e) {
      lastErr = e
      // blockhash 过期/网络抖动:devnet 常见,换新 blockhash 重发(同签名幂等,不会双花)
      if (attempt < 4) await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
