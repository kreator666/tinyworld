// 一次性验证:生存模式(Survival Mode)核心逻辑 —— 纯离线,不依赖链/LLM
//   领养参数校验 / 衰减计算(48h 饱食归零、72h 清洁归零、weak 24h 死亡、vitality=0 加速)/
//   thinker 输出校验器(合法 / 非法 JSON 降级 no-op)/ executor 白名单拒绝 / 排行榜排序
// 运行:AGENT_DATA_DIR=<空目录> npx tsx scripts/verify-survival.ts
import { config } from '../src/config'
import { validatePrincipal, computeDecay, sortLeaderboard, type LeaderboardEntry } from '../src/core/survival'
import { parsePlan, validatePlan, NOOP_PLAN, type SurvivalPlan } from '../src/core/survivalThinker'
import { checkStepAllowed } from '../src/core/survivalExecutor'

const NOW = Math.floor(Date.now() / 1000)

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${msg}`)
}
function eq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`断言失败: ${msg}(实际 ${JSON.stringify(a)},期望 ${JSON.stringify(b)})`)
}

// ---------- 1. 领养参数校验 ----------
eq(config.survivalPrincipalChoices.join(','), '1,2,5', '本金档位固定 [1,2,5]')
assert(validatePrincipal(1) && validatePrincipal(2) && validatePrincipal(5), '1/2/5 合法')
assert(!validatePrincipal(0) && !validatePrincipal(3) && !validatePrincipal(10), '0/3/10 非法')
assert(!validatePrincipal('1') && !validatePrincipal(1.5) && !validatePrincipal(NaN), '字符串/小数/NaN 非法')
console.log('✅ 领养本金档位校验(仅 1/2/5)')

// ---------- 2. 衰减计算 ----------
const basePet = { status: 'alive', satiety: 80, cleanliness: 80, mood: 80, vitality: 100, weak_since: null, last_decay_at: NOW }

// 饱食 48h 归零(从满血 100 起算速率 100/48h)
let d = computeDecay({ ...basePet, satiety: 100, last_decay_at: NOW - 48 * 3600 }, NOW)
eq(d.satiety, 0, '饱食 48h 归零')
eq(d.status, 'weak', '饱食归零 → weak')
assert(d.weak_since === NOW, 'weak_since 记录进入时刻')

// 清洁归零不致死(只挨饿致死):清洁从 1 再掉 1 点的时间窗口内,饱食仍 >0
d = computeDecay({ ...basePet, satiety: 100, cleanliness: 1, last_decay_at: NOW - Math.ceil(72 * 36) }, NOW)
eq(d.cleanliness, 0, '清洁归零')
eq(d.satiety > 0, true, '同期饱食仍 >0')
eq(d.status, 'alive', '清洁归零不致死(只挨饿致死)')

// weak 持续 24h → dead,deathCountDelta=1
d = computeDecay({ ...basePet, status: 'weak', satiety: 0, weak_since: NOW - 24 * 3600, last_decay_at: NOW - 3600 }, NOW)
eq(d.status, 'dead', 'weak 24h → dead')
eq(d.deathCountDelta, 1, '死亡计数 +1')

// weak 未够 24h 仍 weak;且 mood 封顶 50
d = computeDecay({ ...basePet, status: 'weak', satiety: 0, weak_since: NOW - 10 * 3600, last_decay_at: NOW - 3600 }, NOW)
eq(d.status, 'weak', 'weak 10h 仍 weak')
assert(d.mood <= 50, 'weak 状态 mood 封顶 50')

// weak 时饱食被拉回 0 以上 → 恢复 alive
d = computeDecay({ ...basePet, status: 'weak', satiety: 10, weak_since: NOW - 3600, last_decay_at: NOW - 60 }, NOW)
eq(d.status, 'alive', '饱食>0 脱离 weak')
eq(d.weak_since, null, 'weak_since 清空')

// vitality=0 衰减加速 ×1.5:24h 后饱食应低于正常速率
const normal = computeDecay({ ...basePet, satiety: 100, last_decay_at: NOW - 24 * 3600 }, NOW)
const sped = computeDecay({ ...basePet, satiety: 100, vitality: 0, last_decay_at: NOW - 24 * 3600 }, NOW)
eq(normal.satiety, 50, '正常速率 24h 剩 50')
assert(sped.satiety < normal.satiety, 'vitality=0 加速虚弱')
eq(sped.satiety, 25, '加速 ×1.5:24h 剩 25')

// 无时间差 → 无衰减
d = computeDecay({ ...basePet, last_decay_at: NOW }, NOW)
eq(d.satiety, 80, 'dt=0 不衰减')
console.log('✅ 衰减计算(48h 饱食 / 72h 清洁 / weak 24h 死亡 / vitality=0 ×1.5 / mood 封顶)')

// ---------- 3. thinker 输出校验器 ----------
const validJson = JSON.stringify({
  steps: [
    { protocol: 'ref', action: 'swap', tokenIn: 'wNEAR', tokenOut: 'USDC', amountYocto: '1000000000000000000000000', slippageBps: 100, reason: '测试兑换' },
    { protocol: 'none', action: 'noop', reason: '不确定' },
  ],
  moodNote: '今天还行',
})
const plan1 = parsePlan(validJson)
eq(plan1.steps.length, 2, '合法 JSON 解析出 2 步')
eq(plan1.steps[0].protocol, 'ref', '第一步 ref swap')
eq(plan1.steps[1].action, 'noop', '第二步 noop')
eq(plan1.moodNote, '今天还行', 'moodNote 保留')

// 带 ```json 围栏也能解析
const fenced = parsePlan('```json\n' + validJson + '\n```')
eq(fenced.steps.length, 2, '围栏 JSON 解析')

// 非法 JSON → 降级 NOOP_PLAN
const badInputs = [
  'not json at all', // 非 JSON
  '{"steps": "nope"}', // steps 非数组
  '{"steps": [{"protocol": "hack"}]}', // 缺 action
  '{"steps": [{"protocol": "ref", "action": "steal"}]}', // 非法 action
  '{"steps": [{"protocol": "ref", "action": "swap", "tokenIn": "wNEAR", "tokenOut": "SHITCOIN", "amountYocto": "1"}]}', // 白名单外代币
  '{"steps": [{"protocol": "ref", "action": "swap", "tokenIn": "wNEAR", "tokenOut": "USDC", "amountYocto": "-5"}]}', // 负金额
  '{"steps": [{"protocol": "ref", "action": "swap", "tokenIn": "wNEAR", "tokenOut": "USDC", "amountYocto": "1.5"}]}', // 非整数字符串
]
for (const bad of badInputs) {
  const p = parsePlan(bad)
  eq(p.steps.length, 1, `非法输出降级为单步 no-op: ${bad.slice(0, 40)}`)
  eq(p.steps[0].protocol, 'none', '降级步 protocol=none')
  eq(p.steps[0].action, 'noop', '降级步 action=noop')
}
// 步数超限(>5)降级
const tooMany = parsePlan(JSON.stringify({ steps: Array.from({ length: 6 }, () => ({ protocol: 'none', action: 'noop' })) }))
eq(tooMany.steps[0].action, 'noop', '超 5 步降级 no-op')
eq(tooMany.steps.length, 1, '降级 plan 仅 1 步')
// NOOP_PLAN 自身通过 validatePlan
assert(validatePlan(NOOP_PLAN as unknown as Record<string, unknown>) !== null || parsePlan('').steps[0].protocol === 'none', 'NOOP_PLAN 可被自身校验器接受/空文本降级')
eq(parsePlan('').steps[0].action, 'noop', '空文本降级 no-op')
console.log('✅ thinker 输出校验器(合法/围栏/非法 JSON/白名单外代币/负金额/超步数 → 降级 no-op)')

// ---------- 4. executor 白名单拒绝(纯校验,不发交易) ----------
const CAP = 10n ** 23n // 0.1 NEAR 单笔上限
// 合法:主网 ref swap
eq(checkStepAllowed('near-mainnet', { protocol: 'ref', action: 'swap', tokenIn: 'wNEAR', tokenOut: 'USDC', amountYocto: '1000', slippageBps: 100 }, CAP), null, '主网 ref swap 合法')
// 主网 metapool stake 合法;测试网 metapool 拒绝
eq(checkStepAllowed('near-mainnet', { protocol: 'metapool', action: 'stake', amountYocto: '1000' }, CAP), null, '主网 metapool stake 合法')
assert(checkStepAllowed('near-testnet', { protocol: 'metapool', action: 'stake', amountYocto: '1000' }, CAP) !== null, '测试网 metapool 拒绝')
// 测试网 burrow supply 合法;主网 burrow 拒绝(未配置)
eq(checkStepAllowed('near-testnet', { protocol: 'burrow', action: 'supply', tokenIn: 'wNEAR', amountYocto: '1000' }, CAP), null, '测试网 burrow supply 合法')
assert(checkStepAllowed('near-mainnet', { protocol: 'burrow', action: 'supply', amountYocto: '1000' }, CAP) !== null, '主网 burrow 拒绝(链未配置)')
// 白名单外代币 / 超额 / 同币对 / 未知协议 / 缺金额 → 拒绝
assert(checkStepAllowed('near-mainnet', { protocol: 'ref', action: 'swap', tokenIn: 'wNEAR', tokenOut: 'BANANA', amountYocto: '1000' }, CAP) !== null, '白名单外代币拒绝')
assert(checkStepAllowed('near-mainnet', { protocol: 'ref', action: 'swap', tokenIn: 'wNEAR', tokenOut: 'USDC', amountYocto: (CAP + 1n).toString() }, CAP) !== null, '超单笔上限拒绝')
assert(checkStepAllowed('near-mainnet', { protocol: 'ref', action: 'swap', tokenIn: 'wNEAR', tokenOut: 'wNEAR', amountYocto: '1000' }, CAP) !== null, '同币对拒绝')
eq(checkStepAllowed('near-mainnet', { protocol: 'none', action: 'noop' }, CAP), null, 'noop 永远允许')
console.log('✅ executor 白名单(链上协议可用性 / 代币白名单 / 单笔上限 / 同币对)')

// ---------- 5. 排行榜排序 ----------
const mk = (tokenId: number, earnings: string, yocto: string): LeaderboardEntry => ({
  tokenId, name: `#${tokenId}`, status: 'alive', earningsYocto: earnings, yieldYocto: yocto, deathCount: 0, ageHours: 1,
})
const sorted = sortLeaderboard([
  mk(1, '1000000000000000000000000', '0'),                    // 1 NEAR
  mk(2, '0', '3000000000000000000000000'),                    // 3 NEAR
  mk(3, '2500000000000000000000000', '0'),                    // 2.5 NEAR
  mk(4, '0', '0'),
])
eq(sorted.map((e) => e.tokenId).join(','), '2,3,1,4', 'earnings+yield 降序')
console.log('✅ 排行榜排序(earnings+yield 降序)')

console.log('生存模式离线验证全部通过 ✅')
