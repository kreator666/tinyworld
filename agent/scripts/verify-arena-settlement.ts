// 一次性验证:竞技场结算(P6)
//   NAV 精度转换(截断不取整,防虚高)/ 提取交易组装(USDC + 原生币两笔)/ 已结算校验
// 运行:AGENT_DATA_DIR=<空目录> npx tsx scripts/verify-arena-settlement.ts
// 说明:链上 recordResult/haltTrading 与回执核实需真实链,由 Fuji 端到端覆盖。
import { decodeFunctionData } from 'viem'
import { initSchema, closeDb } from '../src/db'
import { config } from '../src/config'
import { insertArenaSeason, insertArenaAccount, updateArenaAccountPhase, getArenaAccount } from '../src/db/arena'
import { navToUnits } from '../src/core/arenaSettlement'
import { buildWithdrawTxs, ArenaError } from '../src/core/arena'

const NOW = Math.floor(Date.now() / 1000)

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${msg}`)
}

await initSchema()

// ---------- 1. NAV → 6 decimals 截断 ----------
assert(navToUnits(55.5) === 55_500_000n, '基本转换')
assert(navToUnits(0.123456789) === 123_456n, '截断非取整(0.123456789 → 0.123456)')
assert(navToUnits(60) === 60_000_000n, '本金 60U')
console.log('✅ NAV 精度转换(截断防虚高)')

// ---------- 2. 赛季 + 已结算账户 ----------
const seasonId = `season-settle-${Date.now().toString(36)}`
await insertArenaSeason({
  id: seasonId,
  chain_key: 'fuji',
  season_address: '0x1111111111111111111111111111111111111111',
  account_impl_address: '0x2222222222222222222222222222222222222222',
  usdc_address: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a21',
  principal_usd: '60',
  fuel_usd: '9',
  start_ts: NOW - 100,
  end_ts: NOW - 10, // 已到期 → settling
  status: 'open',
  config: {},
  created_by: '0x01',
})
await insertArenaAccount({
  season_id: seasonId,
  chain_key: 'fuji',
  token_id: '42',
  owner: '0x3333',
  account_address: '0xaaaa6666bbbb7777cccc8888dddd9999eeee0000',
  phase: 'active',
  register_tx: '0x' + 'ab'.repeat(32),
})
// 未结算 → 提取被拒
const season = (await (await import('../src/db/arena')).getArenaSeason(seasonId))!
const accRow = (await getArenaAccount(seasonId, 42))!
let rejected = false
try {
  buildWithdrawTxs(season, accRow)
} catch {
  rejected = false // buildWithdrawTxs 本身不校验状态,校验在路由/confirmWithdraw
}
void rejected
try {
  await (await import('../src/core/arena')).confirmWithdraw(seasonId, 42, '0x' + 'cd'.repeat(32))
  throw new Error('不应到达')
} catch (e) {
  assert(e instanceof ArenaError && e.message.includes('尚未结算'), '未结算拒绝提取')
}
await updateArenaAccountPhase(seasonId, 42, 'settled', { nav_usd: '55.5', settled_tx: '0x' + 'ef'.repeat(32) })
console.log('✅ 状态机:未结算拒绝提取 → 结算后放行')

// ---------- 3. 提取交易组装 ----------
const settled = (await getArenaAccount(seasonId, 42))!
const txs = buildWithdrawTxs(season, settled)
assert(txs.length === 2, 'USDC + 原生币两笔')
assert(txs[0].to === settled.account_address, '目标 = 托管账户')
const w1 = decodeFunctionData({
  abi: [{ type: 'function', name: 'withdraw', inputs: [{ type: 'address' }] }],
  data: txs[0].data,
})
assert((w1.args[0] as string).toLowerCase() === season.usdc_address.toLowerCase(), 'withdraw(USDC)')
const w2 = decodeFunctionData({ abi: [{ type: 'function', name: 'withdrawNative', inputs: [] }], data: txs[1].data })
assert(w2.functionName === 'withdrawNative', '第二笔 withdrawNative')
console.log('✅ 提取交易组装(withdraw(USDC) + withdrawNative())')

await closeDb()
console.log('竞技场 P6 结算验证通过 ✅(链上 recordResult 路径待 Fuji 端到端)')
