// 一次性验证:竞技场(P1)DB 层 + 核心业务(赛季 CRUD / 注册交易组装 / Playbook 校验 / 冻结组装)
// 运行:AGENT_DATA_DIR=<空目录> npx tsx scripts/verify-arena.ts
// 注意:服务在跑时勿用默认 data 目录(PGlite 禁双进程并发),必须显式给临时目录
import { decodeFunctionData, toFunctionSelector } from 'viem'
import { initSchema, closeDb } from '../src/db'
import { config } from '../src/config'
import {
  insertArenaSeason,
  getArenaSeason,
  listArenaSeasons,
  updateArenaSeason,
  insertArenaAccount,
  getArenaAccount,
  updateArenaAccountPhase,
  initArenaFuel,
  getArenaFuel,
  getArenaPlaybook,
  insertArenaPlaybook,
  listArenaAccounts,
} from '../src/db/arena'
import {
  ArenaError,
  buildFreezeTx,
  buildRegisterTxs,
  deriveSeasonStatus,
  leaderboardOf,
  validatePlaybook,
} from '../src/core/arena'

const CHAIN = config.chainKey
const NOW = Math.floor(Date.now() / 1000)

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${msg}`)
}

await initSchema()
console.log('✅ initSchema 完成(arena 表幂等创建)')

// ---------- 1. 赛季 CRUD + 派生状态 ----------
const seasonId = `season-verify-${Date.now().toString(36)}`
await insertArenaSeason({
  id: seasonId,
  chain_key: CHAIN,
  season_address: '',
  account_impl_address: '',
  usdc_address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a21', // 主网 USDC
  principal_usd: '60',
  fuel_usd: '9',
  start_ts: NOW + 3600,
  end_ts: NOW + 3600 + 100 * 24 * 3600,
  status: 'created',
  config: { maxPositionPct: 40 },
  created_by: '0x0000000000000000000000000000000000000001',
})
const s0 = await getArenaSeason(seasonId)
assert(s0 && Number(s0.principal_usd) === 60 && Number(s0.fuel_usd) === 9, '赛季金额读写')
assert(deriveSeasonStatus(s0!) === 'created', '未回填地址 = created')
await updateArenaSeason(seasonId, { season_address: '0x1111111111111111111111111111111111111111', account_impl_address: '0x2222222222222222222222222222222222222222' })
assert(deriveSeasonStatus((await getArenaSeason(seasonId))!) === 'open', '已部署未开赛 = open')
await updateArenaSeason(seasonId, { start_ts: NOW - 10, end_ts: NOW + 1000 })
assert(deriveSeasonStatus((await getArenaSeason(seasonId))!) === 'active', '开赛未到期 = active')
await updateArenaSeason(seasonId, { end_ts: NOW - 5 })
assert(deriveSeasonStatus((await getArenaSeason(seasonId))!) === 'settling', '到期未结算 = settling')
assert((await listArenaSeasons(CHAIN)).some((r) => r.id === seasonId), '按链列表')
console.log('✅ 赛季 CRUD + 派生状态(created→open→active→settling)')

// ---------- 2. 注册交易组装 ----------
const season = (await getArenaSeason(seasonId))!
const txs = buildRegisterTxs(season, 42, '0x3333333333333333333333333333333333333333' as `0x${string}`)
assert(txs.length === 2, 'approve + register 两笔')
const approve = decodeFunctionData({ abi: [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }] }], data: txs[0].data })
assert((approve.args[1] as bigint) === 69n * 10n ** 6n, 'approve 金额 = 本金60+燃料9(6 decimals)')
assert(txs[1].to === season.season_address, 'register 目标 = 赛季合约')
const reg = decodeFunctionData({ abi: [{ type: 'function', name: 'register', inputs: [{ type: 'uint256' }] }], data: txs[1].data })
assert((reg.args[0] as bigint) === 42n, 'register 参数 = tokenId')
let threw = false
try {
  buildRegisterTxs({ ...season, season_address: '' }, 42, '0x3333333333333333333333333333333333333333' as `0x${string}`)
} catch (e) {
  threw = e instanceof ArenaError
}
assert(threw, '未部署赛季禁止报名')
console.log('✅ 注册交易组装(approve 69U + register)')

// ---------- 3. Playbook 校验 + 版本化 ----------
const good = {
  riskProfile: 'balanced',
  allocation: { fixed_yield: 50, spot: 30, perp: 20 },
  strategies: [
    { type: 'fixed_yield', protocol: 'aave', asset: 'USDC', autoCompound: true },
    { type: 'perp', directionBias: 'neutral', maxLeverage: 3 },
  ],
  guardrails: { maxDailyLossPct: 5, maxDrawdownPct: 30, minCashBufferPct: 20 },
}
assert(validatePlaybook(good) === good, '合法配置通过')
for (const [bad, label] of [
  [{ riskProfile: 'crazy' }, '非法风险档'],
  [{ allocation: { perp: 101 } }, 'allocation 超 100'],
  [{ allocation: { unknown_type: 10 } }, '未知策略类型'],
  [{ strategies: [{ type: 'futures' }] }, '未知策略'],
  [{ guardrails: { maxDailyLossPct: -1 } }, '负数护栏'],
] as const) {
  let rejected = false
  try {
    validatePlaybook(bad)
  } catch (e) {
    rejected = e instanceof ArenaError
  }
  assert(rejected, `非法配置被拒: ${label}`)
}
const v1 = await insertArenaPlaybook(seasonId, 42, good, '0x3333')
const v2 = await insertArenaPlaybook(seasonId, 42, { ...good, riskProfile: 'aggressive' }, '0x3333')
assert(v1 === 1 && v2 === 2, 'Playbook 版本递增')
assert(((await getArenaPlaybook(seasonId, 42))!.config.riskProfile) === 'aggressive', '取最新版本')
console.log('✅ Playbook 校验(6 类非法输入) + 版本化')

// ---------- 4. 参赛账户 + 燃料 + 排行榜 ----------
await insertArenaAccount({
  season_id: seasonId,
  chain_key: CHAIN,
  token_id: '42',
  owner: '0x3333',
  account_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  phase: 'active',
  register_tx: '0x' + 'ab'.repeat(32),
})
await insertArenaAccount({
  season_id: seasonId,
  chain_key: CHAIN,
  token_id: 43,
  owner: '0x4444',
  account_address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  phase: 'active',
  register_tx: '0x' + 'cd'.repeat(32),
})
await initArenaFuel(seasonId, 42, '9')
const fuel = await getArenaFuel(seasonId, 42)
assert(fuel && Number(fuel.balance_usd) === 9 && Number(fuel.total_spent_usd) === 0, '燃料账本初始化')
await updateArenaAccountPhase(seasonId, 42, 'settled', { nav_usd: '72.5', settled_tx: '0x' + 'ef'.repeat(32) })
const board = await leaderboardOf(seasonId)
assert(board[0].token_id === '42' && Number(board[0].nav_usd) === 72.5, '已结算高净值排前')
assert(board[1].token_id === '43', '未结算(净值视为 0)排后')
const acc = await getArenaAccount(seasonId, 42)
assert(acc && acc.phase === 'settled' && acc.settled_tx === '0x' + 'ef'.repeat(32), '结算落库')
console.log('✅ 参赛账户 / 燃料账本 / 排行榜排序')

// ---------- 5. 冻结交易组装 ----------
const freezeTx = buildFreezeTx(season, board[1])
assert(freezeTx.to === '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'freeze 目标 = 托管账户')
assert(freezeTx.data === toFunctionSelector('freeze()'), 'freeze selector')
console.log('✅ 冻结交易组装')

await closeDb()
console.log('竞技场 P1 验证通过 ✅')
