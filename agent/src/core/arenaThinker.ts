import { complete, type LlmUsage } from './llm'
import { getMajorPricesUsd } from './price'
import { buildSkillCatalog } from './arenaSkillCatalog'
import { retrieveArenaMemory } from './arenaMemory'
import { evaluateGuardrails, type GuardState } from './arenaGuard'
import { resolvePlaybook, type EffectivePlaybook } from './arenaPlaybook'
import { getPlaybook } from './arena'
import { listArenaDecisions, listArenaExecutions, type ArenaSeasonRow, type ArenaAccountRow } from '../db/arena'
import { costOfCall, type FuelConfig } from './arenaFuel'
import { getChainContext } from '../chain/registry'

// ============================================================
// 竞技场 Thinker(P4+):只思考,不执行
// 输入完整上下文,输出结构化 DecisionPlan
// ============================================================

export interface DecisionPlan {
  reasoning: string
  riskAssessment: string
  survivalCheck: string
  scores: {
    expectedReturn: number
    risk: number
    survival: number
  }
  intendedActions: Array<{
    toolId: string
    args: Record<string, unknown>
    expectedOutcome: string
    risk: string
  }>
  memoryNote?: string
}

export interface ThinkerContext {
  season: ArenaSeasonRow
  account: ArenaAccountRow
  chainKey: string
  tokenId: number
  guard: GuardState
  playbook: EffectivePlaybook
  fuelBalance: number
  majorPrices: Record<string, { usd: number; change24h: number | null }>
  skillCatalog: string
  memories: string
  recentHistory: string
}

export interface ThinkResult {
  plan: DecisionPlan
  usage: LlmUsage
  costUsd: number
}

function formatPrices(prices: Record<string, { usd: number; change24h: number | null }>): string {
  return Object.entries(prices)
    .map(([sym, p]) => {
      const ch = p.change24h === null ? 'N/A' : `${p.change24h >= 0 ? '+' : ''}${p.change24h.toFixed(2)}%`
      return `${sym}: $${p.usd.toFixed(2)}(24h ${ch})`
    })
    .join(' / ') || '行情数据暂时不可用'
}

async function buildRecentHistory(seasonId: string, tokenId: number, limit = 5): Promise<string> {
  const decisions = await listArenaDecisions(seasonId, tokenId, limit)
  if (decisions.length === 0) return '无近期决策记录。'
  const lines: string[] = []
  for (const d of decisions) {
    const plan = d.plan as unknown as DecisionPlan
    const execs = await listArenaExecutions(d.id)
    const actionSummary =
      plan.intendedActions.length === 0
        ? 'hold'
        : plan.intendedActions.map((a) => a.toolId).join(', ')
    const execSummary = execs
      .map((e) => `${e.tool_id}:${e.status}${e.error ? `(${e.error.slice(0, 60)})` : ''}`)
      .join('; ') || '未执行'
    lines.push(`[${new Date(d.created_at).toISOString()}] ${actionSummary} | 执行: ${execSummary} | 判断: ${plan.reasoning.slice(0, 120)}`)
  }
  return lines.join('\n')
}

export async function buildThinkerContext(
  chainKey: string,
  tokenId: number,
  season: ArenaSeasonRow,
  account: ArenaAccountRow,
  fuelBalance: number,
): Promise<ThinkerContext> {
  const playbookRow = await getPlaybook(season.id, tokenId)
  const playbook = resolvePlaybook(playbookRow?.config, true)
  const guard = await evaluateGuardrails(
    chainKey,
    season.id,
    tokenId,
    account.account_address as `0x${string}`,
    playbook,
    Number(season.principal_usd),
  )
  const [majorPrices, skillCatalog, memories, recentHistory] = await Promise.all([
    getMajorPricesUsd(),
    buildSkillCatalog(chainKey, tokenId),
    retrieveArenaMemory(chainKey, tokenId, '当前市场机会与风险 以及 过去决策失败原因'),
    buildRecentHistory(season.id, tokenId),
  ])
  return {
    season,
    account,
    chainKey,
    tokenId,
    guard,
    playbook,
    fuelBalance,
    majorPrices,
    skillCatalog,
    memories,
    recentHistory,
  }
}

function buildSystemPrompt(): string {
  return `你是竞技场自主交易 agent。你的唯一目标：在赛季内存活下来并尽可能赚钱。

评分规则（每项 1-5）:
- expectedReturn: 这批动作预期能带来多少收益
- risk: 亏损或回撤的可能性与幅度
- survival: 执行后账户是否仍能继续参赛（燃料、现金、回撤、清算风险）

只有当 expectedReturn 足够高、risk 可接受、survival 不被破坏时才输出动作；否则 intendedActions 为空（即 hold）。

可用动作仅限以下 arena 动作（toolId）:
- arena_status: 查询账户状态,无风险,不花钱
- arena_supply: Aave 存入（asset, amountUsd）
- arena_withdraw: Aave 取出（asset, amountUsd?）
- arena_swap: DEX 现货兑换（tokenIn, tokenOut, amountUsd）
- arena_perp_open: GMX 开多/空（indexSymbol, side, sizeUsd, collateralUsd）
- arena_perp_close: GMX 平仓（indexSymbol）

输出严格 JSON,不要任何解释文字:
{
  "reasoning": "当前市场判断+账户应对思路",
  "riskAssessment": "主要风险点",
  "survivalCheck": "燃料/现金/回撤是否安全",
  "scores": {"expectedReturn": 1-5, "risk": 1-5, "survival": 1-5},
  "intendedActions": [{"toolId":"...","args":{},"expectedOutcome":"...","risk":"..."}],
  "memoryNote": "值得记住的一句话(可选)"
}`
}

function buildUserPrompt(ctx: ThinkerContext): string {
  const cfg = getChainContext(ctx.chainKey).cfg
  const principal = Number(ctx.season.principal_usd)
  const nativeSymbol = cfg.defi?.nativeSymbol ?? 'NATIVE'
  return [
    `【账户状态】`,
    `- 链: ${ctx.chainKey}`,
    `- 赛季: ${ctx.season.id}`,
    `- 净值 $${ctx.guard.navUsd.toFixed(2)}(本金 $${principal}, 盈亏 $${(ctx.guard.navUsd - principal).toFixed(2)})`,
    `- 构成: USDC $${ctx.guard.nav.usdcUsd.toFixed(2)} / ${nativeSymbol} $${ctx.guard.nav.nativeUsd.toFixed(2)} / Aave $${ctx.guard.nav.aaveUsd.toFixed(2)} / GMX $${ctx.guard.nav.gmxUsd.toFixed(2)}`,
    `- 现金占比 ${ctx.guard.cashPct.toFixed(1)}%(下限 ${ctx.playbook.guardrails.minCashBufferPct}%)`,
    `- 当日回撤 ${ctx.guard.dailyLossPct.toFixed(2)}%(haltNewPositions=${ctx.guard.haltNewPositions}) / 累计回撤 ${ctx.guard.drawdownPct.toFixed(2)}%(forceDeRisk=${ctx.guard.forceDeRisk})`,
    `- 燃料余额 $${ctx.fuelBalance.toFixed(4)}`,
    `- 风险档 ${ctx.playbook.riskProfile}: 单笔上限 ${ctx.playbook.defaults.maxOrderPct}% NAV, 杠杆上限 ${ctx.playbook.defaults.maxLeverage}x`,
    `- 目标配置 allocation: ${JSON.stringify(ctx.playbook.allocation)}`,
    `- 策略: ${JSON.stringify(ctx.playbook.strategies)}`,
    ``,
    `【市场行情】`,
    `${formatPrices(ctx.majorPrices)}`,
    ``,
    `【可用技能知识库】`,
    `${ctx.skillCatalog}`,
    ``,
    `【相关记忆】`,
    `${ctx.memories || '无'}`,
    ``,
    `【近期决策与执行结果】`,
    `${ctx.recentHistory}`,
  ].join('\n')
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 3
  return Math.max(1, Math.min(5, Math.round(n)))
}

function parsePlan(text: string): DecisionPlan {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('LLM 输出不包含 JSON')
  const obj = JSON.parse(m[0]) as Record<string, unknown>
  const actions: DecisionPlan['intendedActions'] = []
  if (Array.isArray(obj.intendedActions)) {
    for (const a of obj.intendedActions) {
      if (!a || typeof a !== 'object') continue
      const toolId = typeof (a as Record<string, unknown>).toolId === 'string' ? (a as Record<string, unknown>).toolId as string : ''
      if (!toolId) continue
      actions.push({
        toolId,
        args: (a as Record<string, unknown>).args && typeof (a as Record<string, unknown>).args === 'object' ? (a as Record<string, unknown>).args as Record<string, unknown> : {},
        expectedOutcome: String((a as Record<string, unknown>).expectedOutcome ?? ''),
        risk: String((a as Record<string, unknown>).risk ?? ''),
      })
    }
  }
  const scores = obj.scores && typeof obj.scores === 'object' ? (obj.scores as Record<string, unknown>) : {}
  return {
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
    riskAssessment: typeof obj.riskAssessment === 'string' ? obj.riskAssessment : '',
    survivalCheck: typeof obj.survivalCheck === 'string' ? obj.survivalCheck : '',
    scores: {
      expectedReturn: clampScore(Number(scores.expectedReturn ?? 3)),
      risk: clampScore(Number(scores.risk ?? 3)),
      survival: clampScore(Number(scores.survival ?? 3)),
    },
    intendedActions: actions,
    memoryNote: typeof obj.memoryNote === 'string' ? obj.memoryNote : undefined,
  }
}

export async function think(
  ctx: ThinkerContext,
  fuelCfg: FuelConfig,
  meter?: (usage: LlmUsage) => void | Promise<void>,
): Promise<ThinkResult> {
  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 }
  const output = await complete(
    buildSystemPrompt(),
    buildUserPrompt(ctx),
    {
      model: fuelCfg.llmModel,
      temperature: 0.2,
      onUsage: async (u) => {
        usage = u
        if (meter) await meter(u)
      },
    },
  )
  const plan = parsePlan(output)
  const costUsd = costOfCall(fuelCfg, fuelCfg.llmModel, usage)
  return { plan, usage, costUsd }
}
