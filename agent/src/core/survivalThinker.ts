import { config } from '../config'
import { complete, type LlmUsage } from './llm'
import { actualCostUsd } from './survivalCredits'

// ============================================================
// 生存模式决策(无状态一次性 prompt,仿竞技场 Thinker 的轻量版):
// - system prompt 注入宠物状态 / 动作语义 / 白名单协议及方法模板 / 单笔上限 / JSON 输出 schema
// - user prompt 注入当前 NEAR 价格 + 近期 action 结果摘要
// - 输出手写校验器把关:不合法或解析失败一律降级为 no-op(不执行任何链上动作)
// - LLM 走 survival 专用模型源(CompleteOptions.baseUrl/apiKey 覆盖,向后兼容)
// - onUsage → 实际 token 用量按 NEAR AI 定价折算 burnCredits,余额不足抛错(调用方转 dormant)
// ============================================================

export interface SurvivalStep {
  protocol: 'ref' | 'burrow' | 'metapool' | 'none'
  action: 'swap' | 'supply' | 'withdraw' | 'stake' | 'harvest' | 'noop'
  tokenIn?: string
  tokenOut?: string
  amountYocto?: string
  slippageBps?: number
  reason?: string
}

export interface SurvivalPlan {
  steps: SurvivalStep[]
  moodNote: string
}

/** LLM 输出非法时的降级 plan:不执行任何链上动作 */
export const NOOP_PLAN: SurvivalPlan = {
  steps: [{ protocol: 'none', action: 'noop', reason: 'LLM 输出非法,降级为 no-op' }],
  moodNote: '',
}

const PROTOCOLS = ['ref', 'burrow', 'metapool', 'none'] as const
const ACTIONS = ['swap', 'supply', 'withdraw', 'stake', 'harvest', 'noop'] as const
/** 白名单代币(与 executor 校验同源) */
const TOKENS = ['NEAR', 'wNEAR', 'USDC', 'stNEAR'] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 单步校验:字段类型/枚举/代币白名单/金额正整数;合法返回 null,否则返回错误原因 */
export function validateStep(raw: unknown): { step: SurvivalStep } | { error: string } {
  if (!isRecord(raw)) return { error: 'step 不是对象' }
  const protocol = raw.protocol
  const action = raw.action
  if (!PROTOCOLS.includes(protocol as (typeof PROTOCOLS)[number])) return { error: `protocol 非法: ${String(protocol)}` }
  if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) return { error: `action 非法: ${String(action)}` }
  const step: SurvivalStep = { protocol: protocol as SurvivalStep['protocol'], action: action as SurvivalStep['action'] }
  if (raw.tokenIn !== undefined) {
    if (typeof raw.tokenIn !== 'string' || !(TOKENS as readonly string[]).includes(raw.tokenIn)) return { error: `tokenIn 不在白名单: ${String(raw.tokenIn)}` }
    step.tokenIn = raw.tokenIn
  }
  if (raw.tokenOut !== undefined) {
    if (typeof raw.tokenOut !== 'string' || !(TOKENS as readonly string[]).includes(raw.tokenOut)) return { error: `tokenOut 不在白名单: ${String(raw.tokenOut)}` }
    step.tokenOut = raw.tokenOut
  }
  if (raw.amountYocto !== undefined) {
    if (typeof raw.amountYocto !== 'string' || !/^\d+$/.test(raw.amountYocto) || BigInt(raw.amountYocto) <= 0n) {
      return { error: 'amountYocto 必须是正整数字符串(yocto NEAR)' }
    }
    step.amountYocto = raw.amountYocto
  }
  if (raw.slippageBps !== undefined) {
    if (!Number.isInteger(raw.slippageBps) || (raw.slippageBps as number) < 0 || (raw.slippageBps as number) > 1000) {
      return { error: 'slippageBps 必须是 0-1000 的整数' }
    }
    step.slippageBps = raw.slippageBps as number
  }
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== 'string') return { error: 'reason 必须是字符串' }
    step.reason = raw.reason.slice(0, 200)
  }
  return { step }
}

/** plan 级校验:steps 数组(≤5 步) + moodNote;合法返回 plan,null 表示非法(调用方降级 NOOP_PLAN) */
export function validatePlan(raw: unknown): SurvivalPlan | null {
  if (!isRecord(raw)) return null
  if (!Array.isArray(raw.steps) || raw.steps.length > 5) return null
  const steps: SurvivalStep[] = []
  for (const s of raw.steps) {
    const r = validateStep(s)
    if ('error' in r) return null
    steps.push(r.step)
  }
  const moodNote = typeof raw.moodNote === 'string' ? raw.moodNote.slice(0, 200) : ''
  return { steps, moodNote }
}

/** 从 LLM 原始输出解析 plan:剥 ```json 围栏 → JSON.parse → 校验;任何一步失败降级 NOOP_PLAN(纯函数,可离线验证) */
export function parsePlan(text: string): SurvivalPlan {
  let cleaned = text.trim()
  const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)```$/)
  if (fence) cleaned = fence[1].trim()
  // 容错:截取首个 { 到末个 }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return NOOP_PLAN
  let raw: unknown
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return NOOP_PLAN
  }
  return validatePlan(raw) ?? NOOP_PLAN
}

// ------------------------------------------------------------------
// prompt 组装 + LLM 调用
// ------------------------------------------------------------------

export interface ThinkInput {
  chainKey: string
  tokenId: number
  kind: string // 触发动作:feed/clean/work/heal
  stats: { satiety: number; cleanliness: number; mood: number; vitality: number }
  status: string
  principalYocto: string
  earningsYocto: string
  yieldYocto: string
  maxSingleYocto: string // 单笔上限(默认本金的 10%)
  nearPriceUsd: number
  recentActions: Array<{ kind: string; status: string; summary: string }>
  isTestnet: boolean
  /** LLM 实际用量计费回调:burnCredits,余额不足必须抛错(调用方转 dormant) */
  meter: (usage: LlmUsage, costUsd: number) => Promise<void>
}

const ACTION_SEMANTICS: Record<string, string> = {
  feed: '喂食 = 稳健生息(优先低风险质押/存款类动作)',
  clean: '打扫 = 收割整理(收获/整理头寸,落袋收益)',
  work: '打工 = 激进可亏(允许兑换等主动交易,盈亏计入 earnings,可以为负)',
  heal: '治疗 = 把质押收益折算为 credits 恢复状态(不需要链上动作)',
}

function buildSystemPrompt(input: ThinkInput): string {
  const protocols = input.isTestnet
    ? `- ref(Ref Finance AMM,方法:swap){tokenIn,tokenOut,amountYocto,slippageBps}
- burrow(Burrow 借贷,方法:supply/withdraw){tokenIn,amountYocto}
- metapool(仅主网,本链不可用)`
    : `- ref(Ref Finance AMM,方法:swap){tokenIn,tokenOut,amountYocto,slippageBps}
- metapool(Meta Pool 流动质押,方法:stake/harvest){amountYocto}
- burrow(仅测试网,本链不可用)`
  return `你是 TinyWorld 生存模式里的一只电子宠物(每个 NEAR DID agent 一只宠物),由主人点动作触发决策。
当前宠物状态:
- 四维:饱食 ${input.stats.satiety}/100,清洁 ${input.stats.cleanliness}/100,心情 ${input.stats.mood}/100,精力 ${input.stats.vitality}/100
- 状态: ${input.status}(weak/dormant/dead 时不得做激进动作)
- 本金 ${input.principalYocto} yocto NEAR,已实现盈亏 ${input.earningsYocto} yocto,累计质押收益 ${input.yieldYocto} yocto
本次触发动作: ${input.kind}(${ACTION_SEMANTICS[input.kind] ?? '未知动作'})

可选协议(白名单,只能从这里选,不得出现其他目标合约或裸转账):
${protocols}
代币白名单: NEAR / wNEAR / USDC / stNEAR

硬性约束:
1. 单笔 amountYocto ≤ ${input.maxSingleYocto}(单笔上限,默认本金的 10%),必须是正整数字符串
2. swap 必须给 slippageBps(0-1000);tokenIn/tokenOut 必须不同且都在白名单
3. 不确定或状态不佳时用 { "protocol": "none", "action": "noop" },不要硬编动作
4. 最多 5 步,每步必须有 reason(一句话)

只输出 JSON,不要输出任何其他文字,schema:
{"steps":[{"protocol":"ref|burrow|metapool|none","action":"swap|supply|withdraw|stake|harvest|noop","tokenIn":"...","tokenOut":"...","amountYocto":"...","slippageBps":100,"reason":"..."}],"moodNote":"一句话心情"}`
}

function buildUserPrompt(input: ThinkInput): string {
  const recent = input.recentActions.length
    ? input.recentActions.map((a) => `- ${a.kind}: ${a.status}(${a.summary})`).join('\n')
    : '(无记录)'
  return `当前 NEAR 价格: $${input.nearPriceUsd.toFixed(4)}
近期动作结果:
${recent}
请为本轮「${input.kind}」输出决策 JSON。`
}

/** 无状态一次性决策:LLM 输出非法时降级 NOOP_PLAN;meter 抛错(扣费失败)向上传播 */
export async function thinkSurvival(input: ThinkInput): Promise<{ plan: SurvivalPlan; usage: LlmUsage; costUsd: number }> {
  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 }
  const text = await complete(buildSystemPrompt(input), buildUserPrompt(input), {
    model: config.survivalLlmModel,
    temperature: 0.4,
    maxTokens: 900, // 结构化决策 JSON;NEAR AI 等网关默认 max_tokens 偏小,不给足会被截断成非法 JSON
    baseUrl: config.survivalLlmBaseUrl,
    apiKey: config.survivalLlmApiKey,
    onUsage: async (u) => {
      usage = u
      await input.meter(u, await actualCostUsd(u.inputTokens, u.outputTokens))
    },
  })
  const plan = parsePlan(text)
  const costUsd = await actualCostUsd(usage.inputTokens, usage.outputTokens)
  return { plan, usage, costUsd }
}
