import { ARENA_ACTIONS } from '../../runtime-skills/builtins/arena-strategies/index'
import { insertArenaExecution } from '../db/arena'
import { writeArenaMemory } from './arenaMemory'
import type { GuardState } from './arenaGuard'
import type { DecisionPlan } from './arenaThinker'

// ============================================================
// 竞技场 Executor(P4+):消费 Thinker 产出的 DecisionPlan,实际执行动作
// 与 Thinker 解耦:执行失败只写 arena_executions,不影响下一次思考
// ============================================================

interface Job {
  chainKey: string
  tokenId: number
  seasonId: string
  decisionId: string
  guard: GuardState
  plan: DecisionPlan
}

const queue: Job[] = []
let running = false

function isAllowedInGuard(toolId: string, guard: GuardState): { ok: boolean; reason?: string } {
  if (guard.forceDeRisk && !['arena_status', 'arena_withdraw', 'arena_perp_close'].includes(toolId)) {
    return { ok: false, reason: '累计回撤触限,只许降仓/平仓' }
  }
  if (guard.haltNewPositions && !guard.forceDeRisk && ['arena_supply', 'arena_swap', 'arena_perp_open'].includes(toolId)) {
    return { ok: false, reason: '日回撤触限,暂停新开仓/加仓' }
  }
  return { ok: true }
}

async function runJob(job: Job): Promise<void> {
  const { chainKey, tokenId, seasonId, decisionId, guard, plan } = job
  const results: string[] = []
  for (let i = 0; i < plan.intendedActions.length; i++) {
    const a = plan.intendedActions[i]
    const allowed = isAllowedInGuard(a.toolId, guard)
    if (!allowed.ok) {
      await insertArenaExecution({
        decision_id: decisionId,
        action_idx: i,
        tool_id: a.toolId,
        args: a.args,
        status: 'skipped',
        result: {},
        error: allowed.reason ?? null,
      })
      results.push(`${a.toolId}:skipped(${allowed.reason})`)
      continue
    }
    const fn = ARENA_ACTIONS[a.toolId]
    if (!fn) {
      await insertArenaExecution({
        decision_id: decisionId,
        action_idx: i,
        tool_id: a.toolId,
        args: a.args,
        status: 'failed',
        result: {},
        error: '未知动作',
      })
      results.push(`${a.toolId}:failed(未知动作)`)
      continue
    }
    try {
      const r = await fn(chainKey, tokenId, a.args as never)
      await insertArenaExecution({
        decision_id: decisionId,
        action_idx: i,
        tool_id: a.toolId,
        args: a.args,
        status: 'success',
        result: { value: r },
        error: null,
      })
      results.push(`${a.toolId}:success`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await insertArenaExecution({
        decision_id: decisionId,
        action_idx: i,
        tool_id: a.toolId,
        args: a.args,
        status: 'failed',
        result: {},
        error: msg,
      })
      results.push(`${a.toolId}:failed(${msg.slice(0, 80)})`)
    }
  }
  if (plan.intendedActions.length === 0) {
    results.push('hold')
  }
  // 执行结果也写成记忆,供下次思考参考
  const summary = `执行结果: ${results.join('; ')}。原判断: ${plan.reasoning.slice(0, 120)}`
  await writeArenaMemory(chainKey, tokenId, seasonId, 'episodic', summary).catch((e) =>
    console.error('[arena-executor] 写执行记忆失败:', e instanceof Error ? e.message : e),
  )
}

async function workerLoop(): Promise<void> {
  if (running) return
  running = true
  while (queue.length > 0) {
    const job = queue.shift()
    if (!job) continue
    try {
      await runJob(job)
    } catch (err) {
      console.error('[arena-executor] job 失败:', err instanceof Error ? err.message : err)
    }
  }
  running = false
}

/** 把 plan 投入执行队列 */
export function enqueueExecution(
  chainKey: string,
  tokenId: number,
  seasonId: string,
  decisionId: string,
  guard: GuardState,
  plan: DecisionPlan,
): void {
  queue.push({ chainKey, tokenId, seasonId, decisionId, guard, plan })
  workerLoop().catch((err) => console.error('[arena-executor] worker 启动失败:', err instanceof Error ? err.message : err))
}
