// 一次性验证:竞技场燃料计费(P2)
//   计价公式(input/output 分价 × 加成) / 原子扣费+流水 / 余额不足拒绝(不透支) /
//   调度门槛(方案 B:燃料耗尽 = 决策停机,非淘汰) / 固定模型硬约束
// 运行:AGENT_DATA_DIR=<空目录> npx tsx scripts/verify-arena-fuel.ts
import { initSchema, closeDb } from '../src/db'
import { config } from '../src/config'
import { insertArenaSeason, insertArenaAccount, initArenaFuel, getArenaFuel, listFuelLedger, setArenaFuelBalance } from '../src/db/arena'
import { ArenaError } from '../src/core/arena'
import { costOfCall, decisionGate, fuelConfigOf, makeFuelMeter } from '../src/core/arenaFuel'

const NOW = Math.floor(Date.now() / 1000)

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${msg}`)
}

await initSchema()

// ---------- 1. 赛季 config 解析(固定模型/定价/加成默认值) ----------
const seasonId = `season-fuel-${Date.now().toString(36)}`
await insertArenaSeason({
  id: seasonId,
  chain_key: config.chainKey,
  season_address: '0x1111111111111111111111111111111111111111',
  account_impl_address: '0x2222222222222222222222222222222222222222',
  usdc_address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a21',
  principal_usd: '60',
  fuel_usd: '9',
  start_ts: NOW - 10,
  end_ts: NOW + 86400,
  status: 'open',
  config: { llmModel: 'arena-fixed-model', llmPricing: { inputPerM: 0.2, outputPerM: 0.6 } }, // markup 缺省 → 1.0
  created_by: '0x0000000000000000000000000000000000000001',
})
const season = (await (await import('../src/db/arena')).getArenaSeason(seasonId))!
const cfg = fuelConfigOf(season, config.llmModel)
assert(cfg.llmModel === 'arena-fixed-model', '赛季固定模型生效')
assert(cfg.priceMarkup === 1.0 && cfg.inputPerM === 0.2 && cfg.outputPerM === 0.6, '定价解析 + markup 默认 1.0')
console.log('✅ 赛季燃料配置解析(固定模型 / 定价 / 加成默认 1.0)')

// ---------- 2. 计价公式:分价 + 6 位向上取整 ----------
// 100k 输入 @0.2/1M = 0.02;50k 输出 @0.6/1M = 0.03 → 0.05
assert(costOfCall(cfg, 'arena-fixed-model', { inputTokens: 100_000, outputTokens: 50_000 }) === 0.05, '基础计价')
// 加成 1.5:0.05 × 1.5 = 0.075
assert(costOfCall({ ...cfg, priceMarkup: 1.5 }, 'arena-fixed-model', { inputTokens: 100_000, outputTokens: 50_000 }) === 0.075, '加成 1.5')
// 微小用量向上取整:1k 输入 = 0.0002 恰好;1 token 输入 → 0.0000002 → 0.000001
assert(costOfCall(cfg, 'arena-fixed-model', { inputTokens: 1, outputTokens: 0 }) === 0.000001, '6 decimals 向上取整')
// 固定模型硬约束:不允许换模型
let rejected = false
try {
  costOfCall(cfg, 'other-model', { inputTokens: 1000, outputTokens: 0 })
} catch (e) {
  rejected = e instanceof ArenaError
}
assert(rejected, '换模型被拒绝(公平底线)')
console.log('✅ 计价公式(分价 / 取整 / 加成 / 固定模型约束)')

// ---------- 3. 扣费 + 流水 + 原子性(不透支) ----------
await insertArenaAccount({
  season_id: seasonId,
  chain_key: config.chainKey,
  token_id: '42',
  owner: '0x3333',
  account_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  phase: 'active',
  register_tx: '0x' + 'ab'.repeat(32),
})
await initArenaFuel(seasonId, 42, '0.1') // 小额燃料便于耗尽测试
const meter = makeFuelMeter(seasonId, 42, cfg)
await meter({ inputTokens: 100_000, outputTokens: 50_000 }) // 0.05
await meter({ inputTokens: 100_000, outputTokens: 50_000 }) // 0.05
let fuel = await getArenaFuel(seasonId, 42)
assert(Number(fuel!.balance_usd) === 0 && Number(fuel!.total_spent_usd) === 0.1, '扣费后余额/累计消耗')
const ledger = await listFuelLedger(seasonId, 42)
assert(ledger.length === 2 && Number(ledger[1].cost_usd) === 0.05 && Number(ledger[1].balance_after_usd) === 0.05, '流水可回放(首笔)')
assert(Number(ledger[0].balance_after_usd) === 0, '流水可回放(末笔余额归零)')
// 余额不足:拒绝且不产生负余额/脏流水
rejected = false
try {
  await meter({ inputTokens: 100_000, outputTokens: 50_000 })
} catch (e) {
  rejected = e instanceof ArenaError
}
assert(rejected, '余额不足拒绝扣费')
fuel = await getArenaFuel(seasonId, 42)
assert(Number(fuel!.balance_usd) === 0, '无透支')
assert((await listFuelLedger(seasonId, 42)).length === 2, '失败调用不写流水')
console.log('✅ 原子扣费(不透支)+ 流水回放')

// ---------- 4. 调度门槛(方案 B:停机 ≠ 淘汰) ----------
let gate = await decisionGate(seasonId, 42, cfg)
assert(!gate.ok && gate.halted && gate.balance === 0 && gate.estimate === 0.05, '燃尽 → 决策停机,预估=上次实际成本')
// 账户仍是 active(未淘汰),仓位继续计收益
const acc = await (await import('../src/db/arena')).getArenaAccount(seasonId, 42)
assert(acc!.phase === 'active', '方案 B:停机后账户仍 active')
// 补充燃料后(正常赛季无充值入口,这里仅验证门槛逻辑)恢复调度资格
await setArenaFuelBalance(seasonId, 42, '1')
gate = await decisionGate(seasonId, 42, cfg)
assert(gate.ok && !gate.halted, '有余额即恢复调度资格')
console.log('✅ 调度门槛:燃尽停机(保排名)/ 恢复即时生效')

// ---------- 5. 首次预估(无扣费历史) ----------
await initArenaFuel(seasonId, 43, '0.005')
gate = await decisionGate(seasonId, 43, cfg)
assert(gate.estimate === cfg.firstDecisionCostUsd && !gate.ok, '无历史时按 firstDecisionCostUsd 预估,余额不足停机')
console.log('✅ 首次决策预估门槛')

await closeDb()
console.log('竞技场 P2 燃料计费验证通过 ✅')
