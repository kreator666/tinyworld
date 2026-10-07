import { Keypair, VersionedTransaction } from '@solana/web3.js'
import { config } from '../config'
import { getChainContext } from './registry'
import { base58Decode } from '../core/base58'
import { solanaConnection } from './personaSolana'

// ============================================================
// Jupiter v6 兑换(Solana 家族,defi-swap-sol 技能用)
// 官方 api.jup.ag 仅主网;测试网由部署方自托管 jupiter-quote-api
// (指向 testnet RPC)后填入 cfg.solana.jupiterApiUrl,为空 = 本链不支持兑换
// ============================================================

/** 原生 SOL 的 wrap  mint(WSOL) */
export const SOL_MINT = 'So11111111111111111111111111111111111111112'

function jupiterApi(chainKey: string): string {
  const url = getChainContext(chainKey).cfg.solana?.jupiterApiUrl ?? ''
  if (!url) throw new Error(`[${chainKey}] 未配置 Jupiter API(cfg.solana.jupiterApiUrl)`)
  return url.replace(/\/+$/, '')
}

/** 链配置的测试 USDC mint(devnet 通用 4zMMC9…,可用 SOLANA_USDC_MINT 覆盖) */
export function usdcMintOf(chainKey: string): string {
  const mint = getChainContext(chainKey).cfg.solana?.usdcMint
  if (!mint) throw new Error(`[${chainKey}] 未配置 USDC mint(cfg.solana.usdcMint)`)
  return mint
}

/**
 * 报价:GET /quote。返回 Jupiter quoteResponse(含 outAmount/routePlan,直接作为 /swap 的入参)。
 * HTTP 非 2xx 或无可用路由时抛带响应体的 Error。
 */
export async function quoteSwap(
  chainKey: string,
  inputMint: string,
  outputMint: string,
  amountAtomic: bigint,
  slippageBps = 100,
): Promise<Record<string, unknown>> {
  const url = `${jupiterApi(chainKey)}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountAtomic}&slippageBps=${slippageBps}`
  const res = await fetch(url)
  const body = await res.text()
  if (!res.ok) throw new Error(`Jupiter 报价失败 HTTP ${res.status}: ${body.slice(0, 500)}`)
  const json = JSON.parse(body)
  if (!json || typeof json.outAmount !== 'string' || (json.routePlan ?? []).length === 0) {
    throw new Error(`Jupiter 无可用路由: ${body.slice(0, 500)}`)
  }
  return json
}

/** 组装兑换交易:POST /swap,返回 base64 编码的 VersionedTransaction */
export async function buildSwapTransaction(
  chainKey: string,
  quoteResponse: unknown,
  userPublicKey: string,
): Promise<string> {
  const res = await fetch(`${jupiterApi(chainKey)}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse, userPublicKey, wrapUnwrapSOL: true }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`Jupiter 组装交易失败 HTTP ${res.status}: ${body.slice(0, 500)}`)
  const json = JSON.parse(body)
  if (!json || typeof json.swapTransaction !== 'string') {
    throw new Error(`Jupiter 未返回 swapTransaction: ${body.slice(0, 500)}`)
  }
  return json.swapTransaction
}

/**
 * 执行兑换:Agent Solana 热钱包(config.agentSolanaKey,base58 64 字节 secret key)
 * 作为 feePayer + 唯一签名者。反序列化 Jupiter 返回的 VersionedTransaction 后签名,
 * 经 FailoverConnection 发送并确认,返回交易签名。
 */
export async function executeSwap(chainKey: string, quoteResponse: unknown): Promise<string> {
  const secret = config.agentSolanaKey
  if (!secret) throw new Error('未配置 AGENT_SOLANA_PRIVATE_KEY')
  const keypair = Keypair.fromSecretKey(base58Decode(secret))
  const swapTxBase64 = await buildSwapTransaction(chainKey, quoteResponse, keypair.publicKey.toBase58())
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTxBase64, 'base64'))
  tx.sign([keypair])
  const conn = solanaConnection(chainKey)
  const signature = await conn.sendRawTransaction(tx.serialize())
  await conn.confirmTransaction(signature)
  return signature
}
