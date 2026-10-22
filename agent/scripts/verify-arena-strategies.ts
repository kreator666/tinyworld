// 一次性验证:竞技场策略技能(P3)
//   风险预设映射 / 竞技场引擎(复用硬规则、砍软规则)/ ArenaCall 打包(复用 buildUnsigned*)/
//   工具级护栏上限推导
// 运行:AGENT_DATA_DIR=<空目录> npx tsx scripts/verify-arena-strategies.ts
// 说明:链上执行路径(executeArenaCalls/行情)需真实 RPC,本脚本验证离线可验证部分;
//       其余由 P4 集成与 Fuji 端到端覆盖。
import { decodeFunctionData } from 'viem'
import { initSchema, closeDb } from '../src/db'
import { config } from '../src/config'
import { resolvePlaybook, RISK_PRESETS } from '../src/core/arenaPlaybook'
import { evaluateArenaProposal } from '../src/policy/arenaEngine'
import { checkProposalHardRules } from '../src/policy/engine'
import { arenaCallFrom, buildArenaApproveCall, buildArenaTx } from '../src/chain/arenaExec'
import { buildUnsignedSupply, buildUnsignedNativeSupply } from '../src/chain/aave'
import type { Proposal } from '../src/policy/engine'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${msg}`)
}

await initSchema()

// ---------- 1. 风险预设(设计文档 §3.3 映射表) ----------
const cons = resolvePlaybook({ riskProfile: 'conservative' })
const bal = resolvePlaybook({ riskProfile: 'balanced' })
const agg = resolvePlaybook({ riskProfile: 'aggressive' })
assert(cons.defaults.maxLeverage === 2 && cons.guardrails.minCashBufferPct === 40, 'conservative 预设')
assert(bal.defaults.maxLeverage === 3 && bal.guardrails.maxDailyLossPct === 5, 'balanced 预设')
assert(agg.defaults.maxLeverage === 5 && agg.guardrails.maxDrawdownPct === 50, 'aggressive 预设')
// custom:owner 显式值优先,缺的回落 balanced
const custom = resolvePlaybook({ riskProfile: 'custom', guardrails: { maxDailyLossPct: 3 } })
assert(custom.guardrails.maxDailyLossPct === 3 && custom.guardrails.maxDrawdownPct === RISK_PRESETS.balanced.maxDrawdownPct, 'custom:显式优先+默认补全')
// 无配置 → balanced
assert(resolvePlaybook(null).riskProfile === 'balanced', '缺省 balanced')
console.log('✅ 风险预设映射(conservative/balanced/aggressive/custom)')

// ---------- 2. 竞技场引擎 vs 主人模式引擎 ----------
const fujiCfg = (await import('../src/chain/registry')).getChainContext('fuji').cfg
const goodSwap: Proposal = {
  action: 'swap',
  protocol: fujiCfg.defi!.router,
  chainId: fujiCfg.chainId,
  params: { tokenIn: 'native', tokenOut: fujiCfg.defi!.usdc, amountIn: '1000000000000000000' },
  executionMode: 'hot_wallet',
  estimatedValueUsd: 25,
  reason: 'test',
}
const badSwap: Proposal = { ...goodSwap, protocol: '0x9999999999999999999999999999999999999999' }
// 硬规则:两个引擎一致(白名单外协议 → rejected)
assert((await checkProposalHardRules('fuji', badSwap)).length > 0, '硬规则:坏协议被拒')
assert((await evaluateArenaProposal('fuji', badSwap)).verdict === 'rejected', '竞技场引擎:坏协议 rejected')
// 软规则差异:超单笔限额(主人模式 needsApproval)→ 竞技场 execute;估值失败(主人模式 needsApproval)→ 竞技场 rejected
const bigSwap: Proposal = { ...goodSwap, estimatedValueUsd: 99999 }
assert((await evaluateArenaProposal('fuji', bigSwap)).verdict === 'execute', '竞技场:无单笔限额')
const noPrice: Proposal = { ...goodSwap, estimatedValueUsd: null }
assert((await evaluateArenaProposal('fuji', noPrice)).verdict === 'rejected', '竞技场:估值失败=拒绝(无人工可转)')
console.log('✅ 竞技场引擎(硬规则复用 / 软规则裁剪 / 熔断语义差异)')

// ---------- 3. ArenaCall 打包:复用 buildUnsigned*,语义不变 ----------
const account = '0xaaaa6666bbbb7777cccc8888dddd9999eeee0000' as `0x${string}`
const supply = buildUnsignedSupply('fuji', fujiCfg.defi!.usdc as `0x${string}`, 10n ** 6n, account)
const call = arenaCallFrom(supply)
assert(call.target === fujiCfg.aave!.pool, '内部目标 = Aave Pool')
const outer = buildArenaTx('fuji', account, call)
assert(outer.to === account, '外层目标 = ArenaAccount')
// 解码外层 execute(target, value, data) → 内层 calldata 与直接 buildUnsignedSupply 完全一致
const decoded = decodeFunctionData({
  abi: [{ type: 'function', name: 'execute', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }],
  data: outer.data,
})
assert((decoded.args[0] as string).toLowerCase() === fujiCfg.aave!.pool.toLowerCase(), '外层包裹的 target 正确')
assert((decoded.args[2] as string).toLowerCase() === supply.data.toLowerCase(), '内层 calldata 原样透传(onBehalfOf=账户)')
// 原生币存入:value 走账户余额
const nativeSupply = buildUnsignedNativeSupply('fuji', 10n ** 17n, account)
const nativeCall = arenaCallFrom(nativeSupply)
assert(nativeCall.value === 10n ** 17n, '原生币存入的 value 传进 execute')
// approve 打包
const approveCall = buildArenaApproveCall(fujiCfg.defi!.usdc as `0x${string}`, fujiCfg.aave!.pool as `0x${string}`, 10n ** 6n)
assert(approveCall.target.toLowerCase() === fujiCfg.defi!.usdc.toLowerCase(), 'approve 目标 = 代币合约')
console.log('✅ ArenaCall 打包(内层 calldata 复用零改动 / 外层 execute 包裹)')

// ---------- 4. 工具级护栏数值 ----------
const playbook = resolvePlaybook({ riskProfile: 'balanced' })
const nav = 100
const cap = (playbook.defaults.maxOrderPct / 100) * nav
assert(cap === 15, 'balanced 单笔上限 = 15% NAV')
console.log('✅ 护栏数值推导')

await closeDb()
console.log('竞技场 P3 策略技能验证通过 ✅(链上执行路径待 P4 集成 + Fuji 端到端)')
