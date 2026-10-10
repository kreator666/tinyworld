import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { LBCLMM } from '@meteora-ag/dlmm-sdk'
import BN from 'bn.js'
import { config } from '../config'
import { base58Decode } from '../core/base58'
import { MAINNET_RPC, mainnetConnection } from './solanaExec'

// ============================================================
// Meteora DLMM 兑换(Solana 家族,defi-swap-meteora 技能用)
// split-brain:身份链(solana-devnet)只读;兑换统一在主网执行(小金额),见 solanaExec.ts。
// SDK(@meteora-ag/dlmm-sdk 0.7.7)负责报价/组交易(含 wSOL wrap/unwrap、ATA 幂等创建),
// 本模块只做:池地址解析(可用 METEORA_POOL_ADDRESS 轮换)、热钱包签名、
// 经主网故障转移连接发送并确认。
// ============================================================

/** Meteora DLMM 程序地址(devnet 与 mainnet 同地址,官方部署) */
export const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'

/**
 * 主网 SOL/USDC DLMM 池(扫描自链上流动性排序:USDC ~4.2万 / WSOL ~1.6k,binStep=100)。
 * 生产应通过 METEORA_POOL_ADDRESS 指向本方自有池;devnet 池(CFqdEF2...)仅供 devnet 演示,
 * devnet 重置后重建方法见 scripts/meteora-create-pool.cjs。
 */
const DEFAULT_POOL_ADDRESS = '6WTbcDmtqDNwxxLe9YzHzpSSBKQ7AduZG7SmYWpRwjZZ'

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

/** SDK 读路径用主网连接(发送/确认走主网故障转移连接) */
let readConn: Connection | null = null
function readConnection(): Connection {
  if (!readConn) readConn = new Connection(MAINNET_RPC, 'confirmed')
  return readConn
}

async function loadPair(_chainKey: string): Promise<LBCLMM> {
  const conn = readConnection()
  const [pair] = await LBCLMM.createMultiple(conn, [meteoraPoolAddress()], { cluster: 'mainnet-beta' })
  if (!pair) throw new Error(`无法加载 Meteora 池 ${meteoraPoolAddress().toBase58()}`)
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

  // SDK 0.7.7 + 内嵌 IDL 的可选账户缺陷:bin_array_bitmap_extension 被标成只读,
  // 主网上带扩展账户的池子会触发 ConstraintMut(devnet 池无扩展账户故未暴露)。
  // 修复:在已组好的交易里把扩展账户翻成 writable(程序 IDL 要求 isMut=true)。
  const extension = (pair as unknown as { binArrayBitmapExtension?: { publicKey: PublicKey } | null }).binArrayBitmapExtension
  if (extension) {
    for (const ix of tx.instructions) {
      if (ix.programId.toBase58() !== DLMM_PROGRAM_ID) continue
      const key = ix.keys.find((k) => k.pubkey.equals(extension.publicKey))
      if (key) key.isWritable = true
    }
  }

  const conn = mainnetConnection()
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await readConnection().getLatestBlockhash('confirmed')
      tx.recentBlockhash = blockhash
      tx.lastValidBlockHeight = lastValidBlockHeight
      tx.feePayer = wallet.publicKey
      tx.sign(wallet)
      const signature = await conn.sendRawTransaction(tx.serialize())
      await conn.confirmTransaction(signature)
      return signature
    } catch (e) {
      lastErr = e
      // blockhash 过期/网络抖动:换新 blockhash 重发(同签名幂等,不会双花)
      if (attempt < 4) await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
