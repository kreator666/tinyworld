// 生存模式主网端到端(只做一件事:平台热钱包质押 1 NEAR 到 Meta Pool + 快照对账)
// 运行前确认:.env 已配置 AGENT_NEAR_PRIVATE_KEY / AGENT_NEAR_ACCOUNT_ID(主网热钱包,有余额)
//   npx tsx scripts/e2e-survival-stake.ts
// 注意:本脚本会广播真实主网交易(deposit_and_stake),并打印交易哈希与对账结果。
// 资金安全:目标合约固定 meta-pool.near(可经 SURVIVAL_METAPOOL_CONTRACT 覆盖),无其他转账。
import { config } from '../src/config'
import { nearAgentAccountId, nearNativeBalance } from '../src/chain/nearWrite'
import { stakeNear, stNearBalance, stNearPrice, totalStakedValueYocto } from '../src/chain/metapool'

const CHAIN = 'near-mainnet'
const ONE_NEAR = 10n ** 24n

console.log('=== 生存模式主网质押 E2E(1 NEAR) ===')
console.log(`链: ${CHAIN},Meta Pool 合约: ${config.survivalMetaPoolContract}`)

// 0) 前置:热钱包就绪 + 余额充足(本金 + ~0.05N gas 余量)
const accountId = nearAgentAccountId()
const nativeBefore = BigInt(await nearNativeBalance(CHAIN))
console.log(`热钱包: ${accountId}`)
console.log(`原生 NEAR 余额: ${(Number(nativeBefore) / 1e24).toFixed(4)} N`)
if (nativeBefore < ONE_NEAR + ONE_NEAR / 20n) {
  throw new Error('热钱包余额不足 1.05N,请先充值后再运行')
}

// 1) 质押前快照
const stBefore = await stNearBalance(CHAIN, accountId)
const valueBefore = await totalStakedValueYocto(CHAIN, accountId)
console.log(`\n质押前:stNEAR 余额 ${stBefore},总价值 ${(Number(valueBefore) / 1e24).toFixed(6)} NEAR`)
const price = await stNearPrice(CHAIN)
console.log(`stNEAR 价: ${(Number(price) / 1e24).toFixed(6)} NEAR/stNEAR`)

// 2) 真实质押 1 NEAR(广播交易)
console.log('\n广播 deposit_and_stake(1 NEAR)…')
const { txHash } = await stakeNear(CHAIN, ONE_NEAR.toString())
console.log(`交易哈希: ${txHash}`)
console.log(`浏览器: https://nearblocks.io/txns/${txHash}`)

// 3) 质押后快照对账:stNEAR 增量 ≈ 1/价格,总价值增量 ≈ 1 NEAR(允许少量滑点/gas)
const stAfter = await stNearBalance(CHAIN, accountId)
const valueAfter = await totalStakedValueYocto(CHAIN, accountId)
const stDelta = BigInt(stAfter) - BigInt(stBefore)
const valueDelta = valueAfter - valueBefore
console.log(`\n质押后:stNEAR 余额 ${stAfter}(增量 ${stDelta})`)
console.log(`总价值增量: ${(Number(valueDelta) / 1e24).toFixed(6)} NEAR`)
const expectedSt = (ONE_NEAR * ONE_NEAR) / BigInt(price) // 1e24 * 1e24 / price(1e24 定点)
const stDiff = stDelta > expectedSt ? stDelta - expectedSt : expectedSt - stDelta
const ok = valueDelta > ONE_NEAR * 85n / 100n && valueDelta <= ONE_NEAR && stDiff < expectedSt / 50n
if (!ok) {
  throw new Error(`对账失配:总价值增量 ${valueDelta}(期望 ≈1N),stNEAR 增量偏差过大`)
}
console.log('\n对账通过:总价值增量在预期区间,stNEAR 增量与价格吻合 ✅')
console.log('提示:热钱包现有 stNEAR 即平台垫资池,领养/收益快照逻辑会按本金比例分摊')
