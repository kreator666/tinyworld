import { config } from '../config'
import { getDb } from '../db'
import { getChainContext } from '../chain/registry'
import type { UnsignedTx } from '../chain/defi'

// ============================================================
// 策略引擎(M4,设计文档 §7.2):所有链上写操作的必经关卡
// 规则与阈值:单笔限额 / 日累计限额 / 协议白名单 / 代币白名单 / 冷却 / 熔断
// 阈值走 env(POLICY_MAX_TX_USD 等,见 config.ts),默认单笔 $25、日累计 $125、冷却 10 分钟
// ============================================================

export type ExecutionMode = 'hot_wallet' | 'user_wallet'

export type ProposalAction = 'swap' | 'supply' | 'withdraw'

/** 交易提案(defi-swap / defi-lending 生成,审批放行后按 proposal.params 原样执行) */
export interface Proposal {
  action: ProposalAction
  protocol: string // router 地址
  chainId: number
  params: {
    tokenIn: string // 'native' 表示原生币(AVAX/ETH),否则为 ERC20 地址(用户资金路径)
    tokenOut: string // ERC20 地址,或 'native'(代币换原生币);借贷场景记 aToken 描述
    amountIn: string // 最小单位字符串(native=wei,USDC=6 位)
    amountOutMin?: string // 仅 swap 需要(滑点保护)
    owner?: string // 用户资金路径:出资人(主人)地址,代执行时 transferFrom 的 from
  }
  executionMode: ExecutionMode // 由 Agent 设置或用户显式指定
  estimatedValueUsd: number | null // null = 价格源失败(熔断信号)
  reason: string // Agent 给出的提案理由(审计用)
  // 用户钱包签名模式:Agent 组装好但尚未签名的交易(前端钱包签名后后端广播)
  unsignedTxs?: UnsignedTx[]
  // 需要用户钱包签名的前置动作(目前仅 ERC20 approve);前端拿到后弹钱包插件签名
  signatureRequest?: {
    type: 'erc20_approve'
    token: string
    tokenSymbol: string
    spender: string
    amount: string // 最小单位字符串
    decimals: number
  }
}

export interface Verdict {
  verdict: 'execute' | 'needsApproval' | 'rejected'
  reasons: string[]
}

/** 代币白名单(按链):WAVAX/WETH + USDC + USDT(未配置的零地址自动过滤) */
function tokenWhitelist(chainKey: string): string[] {
  const { wNative, usdc, usdt } = getChainContext(chainKey).cfg.defi!
  return [wNative, usdc, usdt].filter((a) => a !== '0x0000000000000000000000000000000000000000').map((a) => a.toLowerCase())
}

/** 当天已执行的 defi 交易总额(USD,tasks 表 result.usdValue 累计) */
async function dailySpentUsd(chainKey: string): Promise<number> {
  const db = await getDb()
  const res = await db.query<{ total: number | null }>(
    `SELECT COALESCE(SUM((result->>'usdValue')::numeric), 0)::float AS total FROM tasks
     WHERE chain_key = $1 AND type = 'defi' AND status = 'done' AND created_at::date = CURRENT_DATE`,
    [chainKey],
  )
  return res.rows[0]?.total ?? 0
}

/** 同 action 距上次执行是否还在冷却期内 */
async function inCooldown(chainKey: string, action: string): Promise<boolean> {
  if (config.policyCooldownSeconds <= 0) return false
  const db = await getDb()
  const res = await db.query(
    `SELECT 1 FROM tasks
     WHERE chain_key = $1 AND type = 'defi' AND status = 'done' AND payload->>'action' = $2
       AND created_at > now() - make_interval(secs => $3)
     LIMIT 1`,
    [chainKey, action, config.policyCooldownSeconds],
  )
  return res.rows.length > 0
}

/**
 * 评估提案:
 * - rejected:白名单外协议/代币、链不匹配(硬规则,人工也不能放行)
 * - needsApproval:估值失败(熔断)、超单笔限额、超日累计、冷却期内(软规则,人工审批可放行)
 * - execute:全部通过
 */
export async function evaluateProposal(chainKey: string, p: Proposal): Promise<Verdict> {
  const cfg = getChainContext(chainKey).cfg
  const hardFail: string[] = []
  const soft: string[] = []

  // 协议白名单:swap 只能走 DEX router;supply/withdraw 只能走 Aave Pool
  if (p.chainId !== cfg.chainId) {
    hardFail.push(`链不匹配(提案 chainId=${p.chainId},当前 ${cfg.chainId})`)
  }
  const allowedProtocol = p.action === 'swap' ? cfg.defi!.router : cfg.aave!.pool
  if (p.protocol.toLowerCase() !== allowedProtocol.toLowerCase()) {
    hardFail.push(`协议不在白名单: ${p.protocol}(当前 action=${p.action} 仅允许 ${allowedProtocol})`)
  }

  // 代币白名单('native' 表示原生币;swap 双向都允许;supply/withdraw 只校验底层资产 tokenIn,
  // tokenOut 在借贷场景记 aToken 地址,由 Aave 协议本身保证其真实性,不重复校验)
  const whitelist = tokenWhitelist(chainKey)
  if (p.params.tokenIn !== 'native' && !whitelist.includes(p.params.tokenIn.toLowerCase())) {
    hardFail.push(`tokenIn 不在白名单: ${p.params.tokenIn}`)
  }
  if (p.action === 'swap' && p.params.tokenOut !== 'native' && !whitelist.includes(p.params.tokenOut.toLowerCase())) {
    hardFail.push(`tokenOut 不在白名单: ${p.params.tokenOut}`)
  }

  if (hardFail.length > 0) return { verdict: 'rejected', reasons: hardFail }

  // 熔断:估值失败一律转人工,绝不自动执行
  if (p.estimatedValueUsd === null) {
    soft.push('价格源不可用,无法估值,按熔断规则转人工审批')
  } else {
    if (p.estimatedValueUsd > config.policyMaxTxUsd) {
      soft.push(`单笔估值 $${p.estimatedValueUsd.toFixed(2)} 超过限额 $${config.policyMaxTxUsd}`)
    }
    const spent = await dailySpentUsd(chainKey)
    if (spent + p.estimatedValueUsd > config.policyDailyLimitUsd) {
      soft.push(`日累计将达到 $${(spent + p.estimatedValueUsd).toFixed(2)},超过日限额 $${config.policyDailyLimitUsd}`)
    }
  }

  if (await inCooldown(chainKey, p.action)) {
    soft.push(`同 action(${p.action})在 ${config.policyCooldownSeconds}s 冷却期内`)
  }

  return soft.length > 0 ? { verdict: 'needsApproval', reasons: soft } : { verdict: 'execute', reasons: [] }
}
