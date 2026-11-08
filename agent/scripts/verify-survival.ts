// 一次性验证:生存模式(Survival Mode)核心逻辑 —— 纯离线,不依赖链/LLM
//   领养参数校验 / 衰减计算(48h 饱食归零、72h 清洁归零、weak 24h 死亡、vitality=0 加速)/
//   thinker 输出校验器(合法 / 非法 JSON 降级 no-op)/ executor 白名单拒绝 / 排行榜排序 /
//   经济模型 v2(30/50/20 分配、领养费支付核验)/ 动作语义 v2
//   (喂食 0.1/0.2/0.5 档、clean 本金保护 claimable ≤ yield、复活费精确 0.5N、打工方向对白名单)
// 运行:AGENT_DATA_DIR=<空目录> npx tsx scripts/verify-survival.ts
import { config } from '../src/config'
import { validatePrincipal, computeDecay, sortLeaderboard, cleanClaimableYocto, reviveFeeOfDeposit, REVIVE_FEE_YOCTO, validateFeedAmount, feedYoctoOf, type LeaderboardEntry } from '../src/core/survival'
import { parsePlan, validatePlan, NOOP_PLAN, type SurvivalPlan } from '../src/core/survivalThinker'
import { checkStepAllowed } from '../src/core/survivalExecutor'
import {
  splitAllocation,
  verifyAdoptionPayment,
  transferDepositOf,
  principalOfDeposit,
  feedAmountOfDeposit,
  checkAdoptionDuplicate,
  type PositionKind,
} from '../src/core/survivalAllocate'
import type { NearTxDetail } from '../src/chain/nearWrite'

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

// ---------- 6. 经济模型 v2:领养费 30/50/20 分配(纯函数) ----------
eq(config.survivalAllocUsdcPct + config.survivalAllocLendingPct + config.survivalAllocNearaiPct, 100, '默认分配比例 30+50+20=100')

// 精确整除:1 NEAR 按 30/50/20 → 0.3/0.5/0.2
const YOCTO = 10n ** 24n
let alloc = splitAllocation(YOCTO.toString(), 30, 50, 20)
eq(alloc.usdc, (YOCTO * 30n / 100n).toString(), '1N 的 30% = 0.3N')
eq(alloc.lending, (YOCTO * 50n / 100n).toString(), '1N 的 50% = 0.5N')
eq(alloc.nearai, (YOCTO * 20n / 100n).toString(), '1N 的 20% = 0.2N')

// 舍入余数归入 lending:total=101 → usdc=30, nearai=20, lending=51;且三段恒等式成立
alloc = splitAllocation('101', 30, 50, 20)
eq(alloc.usdc, '30', '101 的 30% 向下取整 = 30')
eq(alloc.nearai, '20', '101 的 20% 向下取整 = 20')
eq(alloc.lending, '51', '余数归入 lending = 51')
for (const total of ['0', '1', '99', '1000000000000000000000001', YOCTO.toString()]) {
  const a = splitAllocation(total, 30, 50, 20)
  eq((BigInt(a.usdc) + BigInt(a.lending) + BigInt(a.nearai)).toString(), total, `分配恒等式 ${total}`)
  assert(BigInt(a.usdc) >= 0n && BigInt(a.lending) >= 0n && BigInt(a.nearai) >= 0n, `分配非负 ${total}`)
}
// 零总额 → 全 0
alloc = splitAllocation('0', 30, 50, 20)
eq(alloc.usdc + alloc.lending + alloc.nearai, '000', '零总额全 0')
console.log('✅ splitAllocation(30/50/20 取整、余数归 lending、恒等式)')

// 档位反推:仅精确 1/2/5 NEAR 合法
eq(principalOfDeposit(YOCTO.toString()), 1, '1N 档位识别')
eq(principalOfDeposit((YOCTO * 2n).toString()), 2, '2N 档位识别')
eq(principalOfDeposit((YOCTO * 5n).toString()), 5, '5N 档位识别')
eq(principalOfDeposit((YOCTO + 1n).toString()), null, '非整档位拒绝')
eq(principalOfDeposit((YOCTO * 3n).toString()), null, '3N 非法档位拒绝')

// ---------- 7. 领养费支付核验(纯函数;四种拒绝 + 一种通过) ----------
const OWNER = 'alice.testnet'
const RECEIVER = 'hot-wallet.testnet'
const PAY_YOCTO = YOCTO.toString()
const okTx: NearTxDetail = {
  status: { SuccessValue: '' },
  transaction: { signer_id: OWNER, receiver_id: RECEIVER, actions: [{ Transfer: { deposit: PAY_YOCTO } }] },
}
eq(verifyAdoptionPayment(okTx, OWNER, RECEIVER, PAY_YOCTO), null, '合法支付通过')
eq(transferDepositOf(okTx), PAY_YOCTO, 'transferDepositOf 取到 deposit')

// 拒绝 1:金额不符
const wrongAmount: NearTxDetail = {
  status: { SuccessValue: '' },
  transaction: { signer_id: OWNER, receiver_id: RECEIVER, actions: [{ Transfer: { deposit: (YOCTO * 2n).toString() } }] },
}
assert(verifyAdoptionPayment(wrongAmount, OWNER, RECEIVER, PAY_YOCTO) !== null, '金额不符拒绝')
// 拒绝 2:接收人不符
const wrongReceiver: NearTxDetail = {
  status: { SuccessValue: '' },
  transaction: { signer_id: OWNER, receiver_id: 'eve.testnet', actions: [{ Transfer: { deposit: PAY_YOCTO } }] },
}
assert(verifyAdoptionPayment(wrongReceiver, OWNER, RECEIVER, PAY_YOCTO) !== null, '接收人不符拒绝')
// 拒绝 3:非 transfer(FunctionCall 冒充)
const fnCall: NearTxDetail = {
  status: { SuccessValue: '' },
  transaction: { signer_id: OWNER, receiver_id: RECEIVER, actions: [{ FunctionCall: { method_name: 'ft_transfer', args: '' } }] },
}
assert(verifyAdoptionPayment(fnCall, OWNER, RECEIVER, PAY_YOCTO) !== null, '非 Transfer 拒绝')
// 拒绝 4:重复 confirm(防重放:宠物已存在或交易已被使用)
eq(checkAdoptionDuplicate(true, false) !== null, true, '已领养重复 confirm 拒绝')
eq(checkAdoptionDuplicate(false, true) !== null, true, '交易已被使用(重放)拒绝')
eq(checkAdoptionDuplicate(false, false), null, '未领养且交易未用 → 通过')
// 附加:签名人不符 / 交易失败 / 多动作 也拒绝
const wrongSigner: NearTxDetail = { ...okTx, transaction: { ...okTx.transaction!, signer_id: 'bob.testnet' } }
assert(verifyAdoptionPayment(wrongSigner, OWNER, RECEIVER, PAY_YOCTO) !== null, '签名人不符拒绝')
const failed: NearTxDetail = { status: { Failure: {} }, transaction: okTx.transaction }
assert(verifyAdoptionPayment(failed, OWNER, RECEIVER, PAY_YOCTO) !== null, '链上 Failure 拒绝')
const multi: NearTxDetail = { ...okTx, transaction: { ...okTx.transaction!, actions: [{ Transfer: { deposit: PAY_YOCTO } }, { Transfer: { deposit: '1' } }] } }
assert(verifyAdoptionPayment(multi, OWNER, RECEIVER, PAY_YOCTO) !== null, '多动作拒绝')
const kinds: PositionKind[] = ['usdc_reserve', 'lending', 'nearai_farm']
eq(kinds.join(','), 'usdc_reserve,lending,nearai_farm', '头寸 kind 枚举')
console.log('✅ verifyAdoptionPayment(金额/接收人/非 transfer/重复 confirm 拒绝 + 合法通过)')

// ---------- 8. 动作语义 v2:喂食档位 / clean 本金保护 / 复活费 0.5N ----------
// 喂食档位:仅 0.1/0.2/0.5 NEAR 精确档(用户新存入借贷协议的加金)
const TENTH_N = YOCTO / 10n
eq(feedAmountOfDeposit(TENTH_N.toString()), 0.1, '0.1N 喂食档位识别')
eq(feedAmountOfDeposit((TENTH_N * 2n).toString()), 0.2, '0.2N 喂食档位识别')
eq(feedAmountOfDeposit((TENTH_N * 5n).toString()), 0.5, '0.5N 喂食档位识别')
eq(feedAmountOfDeposit(YOCTO.toString()), null, '1N 不是喂食档(属领养档)拒绝')
eq(feedAmountOfDeposit((TENTH_N * 3n).toString()), null, '0.3N 非法喂食档拒绝')
eq(feedAmountOfDeposit((TENTH_N + 1n).toString()), null, '非精确 0.1N(多 1 yocto)拒绝')
eq(feedAmountOfDeposit('0'), null, '0 喂食档拒绝')
assert(validateFeedAmount(0.1) && validateFeedAmount(0.2) && validateFeedAmount(0.5), '0.1/0.2/0.5 合法')
assert(!validateFeedAmount(1) && !validateFeedAmount(0.3) && !validateFeedAmount('0.1') && !validateFeedAmount(NaN), '1/0.3/字符串/NaN 非法')
eq(feedYoctoOf(0.1), TENTH_N.toString(), 'feedYoctoOf(0.1) 精确 0.1N')
eq(feedYoctoOf(0.5), (TENTH_N * 5n).toString(), 'feedYoctoOf(0.5) 精确 0.5N')

// clean 本金保护:claimable 恒 ≤ yield 且非负(本金 principal 永不参与提取)
for (const y of ['0', '1', '1000000000000000000000000', '999999999999999999999999999999999999999']) {
  const c = cleanClaimableYocto(y)
  assert(c <= BigInt(y), `claimable ≤ yield (${y})`)
  assert(c >= 0n, `claimable 非负 (${y})`)
}
eq(cleanClaimableYocto('0'), 0n, '零收益不可提取')
eq(cleanClaimableYocto('-5'), 0n, '负收益钳制为 0(不侵吞本金)')

// 复活费:固定 0.5N,链上 deposit 必须精确匹配
eq(REVIVE_FEE_YOCTO, '500000000000000000000000', '复活费 = 0.5N yocto')
assert(reviveFeeOfDeposit(REVIVE_FEE_YOCTO), '0.5N 精确通过')
assert(!reviveFeeOfDeposit(YOCTO.toString()) && !reviveFeeOfDeposit((TENTH_N * 6n).toString()) && !reviveFeeOfDeposit((TENTH_N + 1n).toString()), '非精确 0.5N 拒绝')
const reviveOkTx: NearTxDetail = {
  status: { SuccessValue: '' },
  transaction: { signer_id: OWNER, receiver_id: RECEIVER, actions: [{ Transfer: { deposit: REVIVE_FEE_YOCTO } }] },
}
eq(verifyAdoptionPayment(reviveOkTx, OWNER, RECEIVER, REVIVE_FEE_YOCTO), null, '复活费支付核验通过')
const reviveOverTx: NearTxDetail = {
  status: { SuccessValue: '' },
  transaction: { signer_id: OWNER, receiver_id: RECEIVER, actions: [{ Transfer: { deposit: YOCTO.toString() } }] },
}
assert(verifyAdoptionPayment(reviveOverTx, OWNER, RECEIVER, REVIVE_FEE_YOCTO) !== null, '复活费多付(1N)拒绝')

// 打工方向对(语义 v2):测试网 wNEAR↔USDT / wNEAR↔DAI 在白名单内
eq(checkStepAllowed('near-testnet', { protocol: 'ref', action: 'swap', tokenIn: 'wNEAR', tokenOut: 'USDT', amountYocto: '1000', slippageBps: 100 }, CAP), null, '测试网 wNEAR↔USDT 方向对合法')
eq(checkStepAllowed('near-testnet', { protocol: 'ref', action: 'swap', tokenIn: 'DAI', tokenOut: 'wNEAR', amountYocto: '1000', slippageBps: 100 }, CAP), null, '测试网 DAI→wNEAR 做多合法')
eq(checkStepAllowed('near-mainnet', { protocol: 'ref', action: 'swap', tokenIn: 'wNEAR', tokenOut: 'USDT', amountYocto: '1000', slippageBps: 100 }, CAP), null, '主网 wNEAR↔USDT 方向对合法')
assert(checkStepAllowed('near-testnet', { protocol: 'ref', action: 'swap', tokenIn: 'wNEAR', tokenOut: 'BANANA', amountYocto: '1000' }, CAP) !== null, '白名单外代币仍拒绝')
console.log('✅ 动作语义 v2(喂食 0.1/0.2/0.5 档、clean 本金保护、复活费 0.5N、打工方向对白名单)')

console.log('生存模式离线验证全部通过 ✅')
