import { FailoverConnection } from './personaSolana'

// ============================================================
// Solana DeFi 执行层(M4·主网阶段)
// 架构约定(split-brain):身份/人格/装备从请求链(当前 = solana-devnet)读取,
// 一切资产操作(Meteora 兑换、Drift 永续)统一在 Solana 主网执行,用小金额。
// 本模块提供主网 RPC 连接、主网 USDC mint、主网浏览器链接与金额硬顶。
// 池地址等由各协议模块用 env 覆盖(DEFAULT 指向主网真实流动性池)。
// ============================================================

function env(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback
}

/** 主网主 RPC(可用 SOLANA_MAINNET_RPC 覆盖为私有节点) */
export const MAINNET_RPC = env('SOLANA_MAINNET_RPC', 'https://api.mainnet-beta.solana.com')

/** 主网备用 RPC(逗号分隔;默认 publicnode 公共节点) */
export const MAINNET_RPC_FALLBACKS = env('SOLANA_MAINNET_RPC_FALLBACKS', 'https://solana-rpc.publicnode.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** 主网 USDC mint(Circle 官方,SPL token,6 位小数) */
export const MAINNET_USDC_MINT = env('SOLANA_MAINNET_USDC_MINT', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

/** 主网浏览器(不带 cluster 参数) */
export const MAINNET_EXPLORER = 'https://explorer.solana.com'

/**
 * 审计/任务表的执行链标识:资产操作虽在请求链的会话上下文里发起,
 * 实际执行链是主网,落库时用它区分 devnet 身份数据与主网资产数据。
 */
export const EXEC_CHAIN_KEY = 'solana-mainnet'

// ---- 金额硬顶(真钱环境的安全护栏;LLM 幻觉/误操作时兜住,env 可调) ----
// 换算假设:SOL 视作数百美元级;测试期小金额,顶额刻意保守。
const num = (key: string, fallback: number) => {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** 单笔兑换输入上限 */
export const MAX_SWAP_SOL_IN = num('SOLANA_MAX_SWAP_SOL_IN', 0.25) // ≈ $50 量级
export const MAX_SWAP_USDC_IN = num('SOLANA_MAX_SWAP_USDC_IN', 100)

/** Drift 单笔入金上限(USDC) */
export const MAX_PERP_DEPOSIT_USDC = num('SOLANA_MAX_PERP_DEPOSIT_USDC', 100)

/** 单笔永续仓位名义价值上限(USD) */
export const MAX_PERP_NOTIONAL_USD = num('SOLANA_MAX_PERP_NOTIONAL_USD', 250)

let conn: FailoverConnection | null = null

/** 主网发送/确认连接(故障转移:主 RPC → 备用) */
export function mainnetConnection(): FailoverConnection {
  if (!conn) conn = new FailoverConnection([MAINNET_RPC, ...MAINNET_RPC_FALLBACKS])
  return conn
}

/** 主网浏览器交易链接 */
export function mainnetTxUrl(signature: string): string {
  return `${MAINNET_EXPLORER}/tx/${signature}`
}

/** 用户钱包签名模式:Agent 组装的 Solana 未签名交易(前端 Phantom 签名后直接广播) */
export interface SolanaUnsignedTx {
  kind: 'solana'
  /** base64 编码的未签名交易(VersionedTransaction 或 legacy Transaction 的 wire format) */
  tx: string
  /** 发送用 RPC 端点(按优先级;主网技能给主网 RPC,devnet 技能给链 RPC) */
  rpcs: string[]
  description: string // human-readable,如 "Jupiter 兑换(SOL↔USDC)"
}
