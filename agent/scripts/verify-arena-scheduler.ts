// 一次性验证:竞技场调度器(P4)
//   调度队列生命周期(登记/到期/优先级提升/完成回调)/ LLM 决策输出解析 /
//   赛季调度旋钮默认值与覆盖
// 运行:AGENT_DATA_DIR=<空目录> npx tsx scripts/verify-arena-scheduler.ts
// 说明:cheap/decision tick 的链上执行路径需真实 RPC,由 Fuji 端到端覆盖。
import { initSchema, closeDb } from '../src/db'
import { config } from '../src/config'
import {
  insertArenaSeason,
  insertArenaAccount,
  ensureArenaDue,
  listDueEntries,
  bumpDuePriority,
  markDueDone,
  lastDecisionAt,
} from '../src/db/arena'
import { knobsOf, parseDecisionActions } from '../src/core/arenaScheduler'

const NOW = Math.floor(Date.now() / 1000)

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${msg}`)
}

await initSchema()

// ---------- 1. 赛季调度旋钮 ----------
const base = {
  id: 'season-sched', chain_key: config.chainKey,
  season_address: '0x1111111111111111111111111111111111111111',
  account_impl_address: '0x2222222222222222222222222222222222222222',
  usdc_address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a21',
  principal_usd: '60', fuel_usd: '9',
  start_ts: NOW - 10, end_ts: NOW + 86400,
  status: 'open', created_by: '0x01',
}
await insertArenaSeason({ ...base, config: {} })
await insertArenaSeason({ ...base, id: 'season-sched2', config: { cheapIntervalSec: 300, decisionIntervalSec: 900, minDecisionIntervalSec: 120 } })
const s1 = (await (await import('../src/db/arena')).getArenaSeason('season-sched'))!
const s2 = (await (await import('../src/db/arena')).getArenaSeason('season-sched2'))!
const k1 = knobsOf(s1)
const k2 = knobsOf(s2)
assert(k1.cheapIntervalSec === 600 && k1.decisionIntervalSec === 1800 && k1.minDecisionIntervalSec === 600, '默认旋钮')
assert(k2.cheapIntervalSec === 300 && k2.minDecisionIntervalSec === 120, '赛季 config 覆盖旋钮')
console.log('✅ 调度旋钮(默认 600/1800/600,赛季可覆盖)')

// ---------- 2. 队列生命周期 ----------
await insertArenaAccount({
  season_id: 'season-sched', chain_key: config.chainKey, token_id: '42',
  owner: '0x3333', account_address: '0xaaaa6666bbbb7777cccc8888dddd9999eeee0000',
  phase: 'active', register_tx: '0x' + 'ab'.repeat(32),
})
await ensureArenaDue('season-sched', 42, NOW + 600, NOW + 1800)
let due = await listDueEntries(NOW + 10_000, 10)
assert(due.length === 2, '登记后 cheap + decision 两行')
// 未到期的扫描不会取出
assert((await listDueEntries(NOW, 10)).length === 0, '未到期不取出')
// 优先级提升:护栏触发(如 forceDeRisk)的 decision 排最前
await bumpDuePriority('season-sched', 42, 'decision', 10, NOW)
due = await listDueEntries(NOW + 10_000, 10)
assert(due[0].kind === 'decision' && due[0].priority === 10, '优先级提升后排最前')
// 完成回调:下次到期时间写回,优先级清零
await markDueDone('season-sched', 42, 'decision', NOW + 3600)
due = await listDueEntries(NOW + 10_000, 10)
const decRow = due.find((d) => d.kind === 'decision')!
assert(decRow.due_ts === NOW + 3600 && decRow.priority === 0, '完成回调:下次到期 + 优先级清零')
assert((await lastDecisionAt('season-sched', 42)) !== null, 'decision 最近执行时间可读')
console.log('✅ 调度队列生命周期(登记/到期过滤/优先级/完成回调)')

// ---------- 3. LLM 决策输出解析(容忍包裹与脏输出) ----------
assert(parseDecisionActions('{"actions":[{"action":"arena_supply","args":{"asset":"USDC","amountUsd":10}}]}').actions.length === 1, '标准 JSON')
assert(parseDecisionActions('```json\n{"actions":[{"action":"arena_swap","args":{"tokenIn":"USDC","tokenOut":"AVAX","amountUsd":5}}]}\n```').actions.length === 1, '代码块包裹')
assert(parseDecisionActions('{"action":"hold"}').actions.length === 0, 'hold = 无动作')
assert(parseDecisionActions('{"actions":[]}').actions.length === 0, '空数组')
assert(parseDecisionActions('今天市场波动太大,我决定观望。').actions.length === 0, '自然语言兜底空')
const parsed = parseDecisionActions('{"actions":[{"action":"arena_perp_open","args":{"indexSymbol":"BTC","side":"LONG","sizeUsd":100,"collateralUsd":50},"reason":"突破"}]}')
assert(parsed.actions[0].action === 'arena_perp_open' && (parsed.actions[0].args as { side: string }).side === 'LONG', '动作与参数透传')
assert(parseDecisionActions('{"action":"hold","reasoning":"现金缓冲已触限，观望"}').reasoning === '现金缓冲已触限，观望', '提取 reasoning')
console.log('✅ 决策输出解析(标准/包裹/hold/脏输入/reasoning)')

await closeDb()
console.log('竞技场 P4 调度器验证通过 ✅(tick 执行路径待 Fuji 端到端)')
