import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { config } from '../config'
import {
  ArenaAccountRow,
  ArenaSeasonRow,
  bumpDuePriority,
  ensureArenaDue,
  lastDecisionAt,
  lastSnapshotAt,
  listArenaAccounts,
  listArenaSeasons,
  listDueEntries,
  markDueDone,
  ArenaDueRow,
} from '../db/arena'
import { deriveSeasonStatus } from './arena'
import { resolvePlaybook } from './arenaPlaybook'
import { getPlaybook } from './arena'
import { fuelConfigOf, decisionGate, makeFuelMeter } from './arenaFuel'
import { evaluateGuardrails, type GuardState } from './arenaGuard'
import { complete } from './llm'
import { ARENA_ACTIONS } from '../../runtime-skills/builtins/arena-strategies/index'
import { settleDueSeasons } from './arenaSettlement'

// ============================================================
// 竞技场统一调度器(P4,设计文档 §8):
// - 中央调度 + 每账户"到期时间",不给每个 agent 独立调度器(防惊群、可做全局优先级)
// - 两层 tick:cheap(纯代码,不调 LLM 不烧燃料)与 decision(LLM,燃料门槛 + 最小间隔地板)
// - 并发闸门:LLM 信号量 + 滚动 RPM;护栏触发优先级提升;高负载降级只拉长常规巡检
// - arena_due 表驱动,崩溃恢复不丢止损窗口
// ============================================================

interface SchedKnobs {
  cheapIntervalSec: number // 常规巡检间隔(默认 10min)
  decisionIntervalSec: number // 常规决策间隔(默认 30min)
  minDecisionIntervalSec: number // 两次 decision 的最小间隔地板(默认 10min)
  snapshotIntervalSec: number // 净值快照间隔(默认 4h)
  deviationThresholdPct: number // allocation 偏离触发决策的阈值(默认 15 百分点)
}

export function knobsOf(season: ArenaSeasonRow): SchedKnobs {
  const c = (season.config ?? {}) as Record<string, unknown>
  const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt)
  return {
    cheapIntervalSec: num(c.cheapIntervalSec, 600),
    decisionIntervalSec: num(c.decisionIntervalSec, 1800),
    minDecisionIntervalSec: num(c.minDecisionIntervalSec, 600),
    snapshotIntervalSec: num(c.snapshotIntervalSec, 14_400),
    deviationThresholdPct: num(c.deviationThresholdPct, 15),
  }
}

/** 全局并发闸门:同时进行的 decision tick 数 + 滚动窗口 LLM 调用限流 */
const gate = {
  running: 0,
  maxRunning: 4,
  windowStart: 0,
  windowCount: 0,
  maxPerWindow: 10, // 每 60s 最多 10 次 LLM 调用
}

function llmSlotAvailable(nowMs: number): boolean {
  if (gate.running >= gate.maxRunning) return false
  if (nowMs - gate.windowStart > 60_000) {
    gate.windowStart = nowMs
    gate.windowCount = 0
  }
  return gate.windowCount < gate.maxPerWindow
}

async function recordArenaTask(chainKey: string, tokenId: number, payload: Record<string, unknown>, result: Record<string, unknown>, status: 'done' | 'failed' = 'done') {
  const db = await getDb()
  await db.query('INSERT INTO tasks (id, chain_key, token_id, type, status, payload, result) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    randomUUID(),
    chainKey,
    tokenId,
    'arena',
    status,
    JSON.stringify(payload),
    JSON.stringify(result),
  ])
}

// ------------------------------------------------------------------
// cheap tick:拉行情/净值、查护栏、写快照、算 allocation 偏离
// ------------------------------------------------------------------

async function runCheapTick(season: ArenaSeasonRow, account: ArenaAccountRow, knobs: SchedKnobs, nowSec: number): Promise<void> {
  const tokenId = Number(account.token_id)
  const chainKey = season.chain_key
  try {
    const playbook = resolvePlaybook((await getPlaybook(season.id, tokenId))?.config)
    const guard = await evaluateGuardrails(chainKey, season.id, tokenId, account.account_address as `0x${string}`, playbook, Number(season.principal_usd))
    // 快照(净值曲线的数据源)
    const lastSnap = await lastSnapshotAt(season.id, tokenId)
    if (lastSnap === null || nowSec - lastSnap >= knobs.snapshotIntervalSec) {
      const { insertSnapshot } = await import('../db/arena')
      await insertSnapshot(season.id, tokenId, guard.navUsd, {
        usdc: guard.nav.usdcUsd, native: guard.nav.nativeUsd, aave: guard.nav.aaveUsd, gmx: guard.nav.gmxUsd,
        drawdownPct: guard.drawdownPct, dailyLossPct: guard.dailyLossPct,
      })
    }
    // allocation 偏离 → 提升 decision 优先级(下轮调度优先分析)
    const alloc = playbook.allocation
    if (guard.navUsd > 0 && (alloc.fixed_yield !== undefined || alloc.perp !== undefined || alloc.spot !== undefined)) {
      const actual: Record<string, number> = {
        fixed_yield: (guard.nav.aaveUsd / guard.navUsd) * 100,
        perp: (guard.nav.gmxUsd / guard.navUsd) * 100,
      }
      for (const [k, target] of Object.entries(alloc)) {
        const dev = Math.abs((actual[k === 'spot' ? 'spot' : (k as 'fixed_yield' | 'perp')] ?? 0) - target)
        if (dev >= knobs.deviationThresholdPct) {
          await bumpDuePriority(season.id, tokenId, 'decision', 5)
          break
        }
      }
    }
    // 护栏触发:日回撤触限 → 决策立即(复盘/降仓);累计回撤触限 → 最高优先级
    if (guard.forceDeRisk) await bumpDuePriority(season.id, tokenId, 'decision', 10)
    else if (guard.haltNewPositions) await bumpDuePriority(season.id, tokenId, 'decision', 8)
    await recordArenaTask(chainKey, tokenId, { action: 'cheap_tick', season: season.id }, {
      navUsd: guard.navUsd.toFixed(2), dailyLossPct: guard.dailyLossPct.toFixed(2), drawdownPct: guard.drawdownPct.toFixed(2),
      haltNewPositions: guard.haltNewPositions, forceDeRisk: guard.forceDeRisk,
    })
  } catch (err) {
    console.error(`[arena:${chainKey}] cheap tick 失败(token=${tokenId}):`, err instanceof Error ? err.message : err)
  } finally {
    await markDueDone(season.id, tokenId, 'cheap', nowSec + knobs.cheapIntervalSec)
  }
}

// ------------------------------------------------------------------
// decision tick:燃料门槛 + 最小间隔地板 + 护栏闸门 → 无状态 LLM 决策 → 动作分发
// ------------------------------------------------------------------

/** 无状态一次性 prompt:只注入结构化状态摘要,不挂聊天历史/记忆检索(燃料可控且可比) */
function buildDecisionPrompt(season: ArenaSeasonRow, guard: GuardState, playbook: ReturnType<typeof resolvePlaybook>, fuelBalance: number, recentTrades: string): string {
  const principal = Number(season.principal_usd)
  return [
    `你是竞技场赛季中的自主交易 agent,当前账户状态(USD):`,
    `- 净值 ${guard.navUsd.toFixed(2)}(本金 ${principal},盈亏 ${(guard.navUsd - principal).toFixed(2)})`,
    `- 构成:USDC ${guard.nav.usdcUsd.toFixed(2)} / 原生币 ${guard.nav.nativeUsd.toFixed(2)} / Aave ${guard.nav.aaveUsd.toFixed(2)} / GMX ${guard.nav.gmxUsd.toFixed(2)}`,
    `- 现金占比 ${guard.cashPct.toFixed(1)}%(下限 ${playbook.guardrails.minCashBufferPct}%)`,
    `- 当日回撤 ${guard.dailyLossPct.toFixed(2)}%(触限 ${guard.haltNewPositions})/ 累计回撤 ${guard.drawdownPct.toFixed(2)}%(${guard.forceDeRisk ? '触限:只许降仓' : '未触限'})`,
    `- 风险档 ${playbook.riskProfile}:单笔上限 ${playbook.defaults.maxOrderPct}% NAV,杠杆上限 ${playbook.defaults.maxLeverage}x`,
    `- 目标配置 allocation:${JSON.stringify(playbook.allocation)};策略:${JSON.stringify(playbook.strategies)}`,
    `- 燃料余额 $${fuelBalance.toFixed(4)}(每次决策都烧燃料,无意义地频繁决策会提前停机)`,
    `- 近期动作:${recentTrades || '无'}`,
    `可用动作:arena_supply/arena_withdraw(Aave 固收)、arena_swap(现货)、arena_perp_open/arena_perp_close(GMX)、或 hold(什么都不做)。`,
    `要求:只做配置内的策略;不要解释,严格输出 JSON:{"actions":[{"action":"...","args":{...},"reason":"..."}]},无动作输出 {"actions":[]},也可以输出 {"action":"hold"}。`,
  ].join('\n')
}

/** 从 LLM 输出中稳健提取动作数组(容忍 ```json 包裹与额外文字) */
export function parseDecisionActions(text: string): { action: string; args?: Record<string, unknown>; reason?: string }[] {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return []
  try {
    const obj = JSON.parse(m[0]) as Record<string, unknown>
    if (obj.action === 'hold') return []
    const arr = Array.isArray(obj.actions) ? obj.actions : []
    return arr
      .filter((a) => a && typeof a === 'object' && typeof (a as Record<string, unknown>).action === 'string')
      .map((a) => a as { action: string; args?: Record<string, unknown>; reason?: string })
  } catch {
    return []
  }
}

async function runDecisionTick(season: ArenaSeasonRow, account: ArenaAccountRow, knobs: SchedKnobs, nowSec: number): Promise<void> {
  const tokenId = Number(account.token_id)
  const chainKey = season.chain_key
  const fuelCfg = fuelConfigOf(season, config.llmModel)
  try {
    const playbook = resolvePlaybook((await getPlaybook(season.id, tokenId))?.config)
    const guard = await evaluateGuardrails(chainKey, season.id, tokenId, account.account_address as `0x${string}`, playbook, Number(season.principal_usd))
    // 方案 B 燃料停机:不进 LLM,已有仓位继续计收益
    const fg = await decisionGate(season.id, tokenId, fuelCfg)
    if (!fg.ok) {
      await recordArenaTask(chainKey, tokenId, { action: 'decision_halted', season: season.id }, { balance: fg.balance, estimate: fg.estimate })
      await markDueDone(season.id, tokenId, 'decision', nowSec + knobs.decisionIntervalSec)
      return
    }
    // 最小间隔地板(全局,与燃料无关)
    const lastAt = await lastDecisionAt(season.id, tokenId)
    if (lastAt !== null && nowSec - lastAt < knobs.minDecisionIntervalSec) {
      await markDueDone(season.id, tokenId, 'decision', (lastAt + knobs.minDecisionIntervalSec))
      return
    }
    // 日回撤触限:今天不再新开仓(省燃料);只等 cheap tick 继续监控
    if (guard.haltNewPositions && !guard.forceDeRisk) {
      await recordArenaTask(chainKey, tokenId, { action: 'daily_halt', season: season.id }, { dailyLossPct: guard.dailyLossPct })
      await markDueDone(season.id, tokenId, 'decision', nowSec + knobs.decisionIntervalSec)
      return
    }
    if (!llmSlotAvailable(Date.now())) {
      await markDueDone(season.id, tokenId, 'decision', nowSec + 60) // 限流:1 分钟后再试
      return
    }
    gate.running += 1
    gate.windowCount += 1
    try {
      const recent = await recentTradesSummary(season.id, tokenId)
      const output = await complete(
        '你是竞技场自主交易 agent。只输出指定格式的 JSON,不输出其他文字。',
        buildDecisionPrompt(season, guard, playbook, fg.balance, recent),
        { model: fuelCfg.llmModel, temperature: 0.2, onUsage: makeFuelMeter(season.id, tokenId, fuelCfg) },
      )
      const actions = parseDecisionActions(output)
      const results: { action: string; ok: boolean; detail: string }[] = []
      for (const a of actions) {
        // forceDeRisk:只许降仓类动作
        if (guard.forceDeRisk && !['arena_withdraw', 'arena_perp_close', 'arena_status'].includes(a.action)) {
          results.push({ action: a.action, ok: false, detail: '累计回撤触限,只许降仓/平仓' })
          continue
        }
        const fn = ARENA_ACTIONS[a.action]
        if (!fn) {
          results.push({ action: a.action, ok: false, detail: '未知动作' })
          continue
        }
        try {
          const r = await fn(chainKey, tokenId, (a.args ?? {}) as never)
          results.push({ action: a.action, ok: true, detail: JSON.stringify(r).slice(0, 200) })
        } catch (err) {
          results.push({ action: a.action, ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : String(err) })
        }
      }
      await recordArenaTask(chainKey, tokenId, { action: 'decision_tick', season: season.id }, { actions: results })
      console.log(`[arena:${chainKey}] decision tick(token=${tokenId}): ${results.map((r) => `${r.action}${r.ok ? '✓' : '✗'}`).join(' ') || 'hold'}`)
    } finally {
      gate.running -= 1
      await markDueDone(season.id, tokenId, 'decision', nowSec + knobs.decisionIntervalSec)
    }
  } catch (err) {
    console.error(`[arena:${chainKey}] decision tick 失败(token=${tokenId}):`, err instanceof Error ? err.message : err)
    await markDueDone(season.id, tokenId, 'decision', nowSec + knobs.decisionIntervalSec).catch(() => {})
  }
}

async function recentTradesSummary(seasonId: string, tokenId: number): Promise<string> {
  const db = await getDb()
  const res = await db.query<{ strategy_type: string; action: string; created_at: string }>(
    `SELECT strategy_type, action, created_at FROM arena_trades
     WHERE season_id = $1 AND token_id = $2 ORDER BY created_at DESC LIMIT 5`,
    [seasonId, tokenId],
  )
  return res.rows.map((r) => `${r.strategy_type}/${r.action}`).join(', ')
}

// ------------------------------------------------------------------
// 主循环
// ------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null
let ticking = false

async function tickArena(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const nowSec = Math.floor(Date.now() / 1000)
    // 1) 登记:active 赛季的 active 账户进调度表(幂等)
    const seasons = (await listArenaSeasons()).filter((s) => deriveSeasonStatus(s, nowSec) === 'active')
    const activeKeys = new Set<string>()
    for (const s of seasons) {
      const knobs = knobsOf(s)
      for (const a of await listArenaAccounts(s.id)) {
        if (a.phase !== 'active') continue
        activeKeys.add(`${s.id}:${a.token_id}`)
        await ensureArenaDue(s.id, Number(a.token_id), nowSec + knobs.cheapIntervalSec, nowSec + knobs.decisionIntervalSec)
      }
    }
    // 2) 到期的执行(cheap 顺序跑;decision 过闸门)
    const due = await listDueEntries(nowSec, 200)
    for (const row of due) {
      const key = `${row.season_id}:${row.token_id}`
      const season = seasons.find((s) => s.id === row.season_id)
      if (!season || !activeKeys.has(key)) {
        await markDueDone(row.season_id, Number(row.token_id), row.kind, nowSec + 3600) // 非 active:1 小时后再看一眼
        continue
      }
      const account = (await listArenaAccounts(row.season_id)).find((a) => String(a.token_id) === String(row.token_id))
      if (!account) continue
      const knobs = knobsOf(season)
      if (row.kind === 'cheap') await runCheapTick(season, account, knobs, nowSec)
      else await runDecisionTick(season, account, knobs, nowSec)
    }
    // 3) 到期赛季结算(熔断 + recordResult + 归档)
    await settleDueSeasons(nowSec).catch((err) => console.error('[arena] 结算失败:', err instanceof Error ? err.message : err))
  } catch (err) {
    console.error('[arena] 调度轮失败:', err instanceof Error ? err.message : err)
  } finally {
    ticking = false
  }
}

export function startArenaScheduler(): void {
  const seconds = config.arenaSchedulerSeconds
  console.log(`竞技场调度器已启动:每 ${seconds}s 扫描一轮`)
  tickArena().catch((err) => console.error('[arena] 首轮失败:', err))
  timer = setInterval(() => {
    tickArena().catch((err) => console.error('[arena] 调度轮失败:', err))
  }, seconds * 1000)
}

export function stopArenaScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
