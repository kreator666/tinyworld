import { config } from '../config'
import { getDb } from '../db'

// ============================================================
// 策略引擎(M4,设计文档 §7.2):所有链上写操作的必经关卡
// 规则与阈值:单笔限额 / 日累计限额 / 协议白名单 / 代币白名单 / 冷却 / 熔断
// 阈值走 env(POLICY_MAX_TX_USD 等,见 config.ts),默认单笔 $25、日累计 $125、冷却 10 分钟
// ============================================================

/** 交易提案(defi-swap 生成,审批放行后按 proposal.params 原样执行) */
export interface Proposal {
  action: 'swap'
  protocol: string // router 地址
  chainId: number
  params: {
    tokenIn: string // 'native' 表示原生币(AVAX/ETH)
    tokenOut: string // ERC20 地址
    amountInWei: string // bigint 序列化
    amountOutMin: string
  }
  estimatedValueUsd: number | null // null = 价格源失败(熔断信号)
  reason: string // Agent 给出的提案理由(审计用)
}

export interface Verdict {
  verdict: 'execute' | 'needsApproval' | 'rejected'
  reasons: string[]
}

/** 代币白名单(按链):WAVAX/WETH + USDC */
function tokenWhitelist(): string[] {
  const { wNative, usdc } = config.chain.defi
  return [wNative, usdc].filter((a) => a !== '0x0000000000000000000000000000000000000000').map((a) => a.toLowerCase())
}

/** 当天已执行的 defi 交易总额(USD,tasks 表 result.usdValue 累计) */
async function dailySpentUsd(): Promise<number> {
  const db = await getDb()
  const res = await db.query<{ total: number | null }>(
    `SELECT COALESCE(SUM((result->>'usdValue')::numeric), 0)::float AS total FROM tasks
     WHERE type = 'defi' AND status = 'done' AND created_at::date = CURRENT_DATE`,
  )
  return res.rows[0]?.total ?? 0
}

/** 同 action 距上次执行是否还在冷却期内 */
async function inCooldown(action: string): Promise<boolean> {
  if (config.policyCooldownSeconds <= 0) return false
  const db = await getDb()
  const res = await db.query(
    `SELECT 1 FROM tasks
     WHERE type = 'defi' AND status = 'done' AND payload->>'action' = $1
       AND created_at > now() - make_interval(secs => $2)
     LIMIT 1`,
    [action, config.policyCooldownSeconds],
  )
  return res.rows.length > 0
}

/**
 * 评估提案:
 * - rejected:白名单外协议/代币、链不匹配(硬规则,人工也不能放行)
 * - needsApproval:估值失败(熔断)、超单笔限额、超日累计、冷却期内(软规则,人工审批可放行)
 * - execute:全部通过
 */
export async function evaluateProposal(p: Proposal): Promise<Verdict> {
  const hardFail: string[] = []
  const soft: string[] = []

  // 协议白名单:router 地址精确匹配当前链配置
  if (p.chainId !== config.chain.chainId) {
    hardFail.push(`链不匹配(提案 chainId=${p.chainId},当前 ${config.chain.chainId})`)
  }
  if (p.protocol.toLowerCase() !== config.chain.defi.router.toLowerCase()) {
    hardFail.push(`协议不在白名单: ${p.protocol}(当前链仅允许 ${config.chain.defi.router})`)
  }

  // 代币白名单
  const whitelist = tokenWhitelist()
  if (p.params.tokenIn !== 'native' && !whitelist.includes(p.params.tokenIn.toLowerCase())) {
    hardFail.push(`tokenIn 不在白名单: ${p.params.tokenIn}`)
  }
  if (!whitelist.includes(p.params.tokenOut.toLowerCase())) {
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
    const spent = await dailySpentUsd()
    if (spent + p.estimatedValueUsd > config.policyDailyLimitUsd) {
      soft.push(`日累计将达到 $${(spent + p.estimatedValueUsd).toFixed(2)},超过日限额 $${config.policyDailyLimitUsd}`)
    }
  }

  if (await inCooldown(p.action)) {
    soft.push(`同 action(${p.action})在 ${config.policyCooldownSeconds}s 冷却期内`)
  }

  return soft.length > 0 ? { verdict: 'needsApproval', reasons: soft } : { verdict: 'execute', reasons: [] }
}
