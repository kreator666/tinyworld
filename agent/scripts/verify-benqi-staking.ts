// 一次性冒烟验证:BENQI 流动性质押技能(defi-staking)
// 覆盖: seeding(avalanche 有 benqi-staking 行、fuji 无)/ 清单按链 gating /
//       工具装配(owner 模式有 propose_stake+staking_status,social 模式无)/
//       策略引擎白名单(staking action)/ 主网真实只读(汇率+cooldown+报价)
// 用法: npx tsx scripts/verify-benqi-staking.ts(自带独立数据目录;主网只读走公共 RPC,不发交易)
import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = path.resolve(process.cwd(), 'data-smoke-benqi-staking').replaceAll('\\', '/')
fs.rmSync(DATA_DIR, { recursive: true, force: true })
process.env.AGENT_DATA_DIR = DATA_DIR

const { initSchema, closeDb, listChains, loadChainConfigsFromDb, listChainProtocols, upsertChainProtocol } = await import('../src/db')
const { applyDbChains, applyDbChainConfigs } = await import('../src/chain/registry')
const { seedChainProtocols } = await import('../src/skills/protocolSeeding')
const {
  listSkills,
  getToolsFor,
  installSkill,
  uninstallSkill,
  syncSkillsToDb,
  refreshProtocolCache,
} = await import('../src/skills')
const { evaluateProposal } = await import('../src/policy/engine')
const { fetchStakingInfo, quoteStake, benqiCfg } = await import('../src/chain/benqi')
const { getPublicClient } = await import('../src/chain/clients')
const { parseEther, formatEther } = await import('viem')
import type { Address } from 'viem'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`断言失败: ${msg}`)
}
let passed = 0
function ok(msg: string): void {
  passed++
  console.log(`✅ ${msg}`)
}

await initSchema()
applyDbChains(await listChains())
applyDbChainConfigs(await loadChainConfigsFromDb())
await seedChainProtocols()
refreshProtocolCache(await listChainProtocols())
await syncSkillsToDb()

// 1. seeding:avalanche 有 benqi-staking(enabled,config 带 staking/sAvax),fuji 无
const protos = await listChainProtocols()
const avaxProtos = protos.filter((p) => p.chain_key === 'avalanche')
const benqiRow = avaxProtos.find((p) => p.protocol_key === 'benqi-staking')
assert(benqiRow && benqiRow.enabled && benqiRow.kind === 'staking', `avalanche 应 seed benqi-staking 行: ${JSON.stringify(benqiRow)}`)
assert(benqiRow!.config.staking === '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE', 'benqi-staking config.staking 应为核实地址')
assert(!protos.some((p) => p.chain_key === 'fuji' && p.protocol_key === 'benqi-staking'), 'fuji 不应有 benqi-staking 行')
ok('seeding: avalanche 有 benqi-staking(enabled),fuji 无')

// 2. 清单 gating:avalanche 含 defi-staking,fuji/sepolia 不含
const avaxSkills = listSkills('avalanche')
assert(avaxSkills.some((s) => s.id === 'defi-staking' && s.protocol === 'benqi-staking'), 'avalanche 清单应有 defi-staking')
assert(!listSkills('fuji').some((s) => s.id === 'defi-staking'), 'fuji 清单不应有 defi-staking(主网专属)')
assert(!listSkills('sepolia').some((s) => s.id === 'defi-staking'), 'sepolia 清单不应有 defi-staking')
ok('清单 gating: 仅主网可见 defi-staking')

// 3. 停用协议 → 清单隐藏 → 恢复(与 gating 框架联动)
await upsertChainProtocol({ chain_key: 'avalanche', protocol_key: 'benqi-staking', kind: 'staking', config: {}, enabled: false, updated_by: 'smoke' })
refreshProtocolCache(await listChainProtocols())
assert(!listSkills('avalanche').some((s) => s.id === 'defi-staking'), '停用 benqi-staking 后主网清单应隐藏 defi-staking')
await upsertChainProtocol({ chain_key: 'avalanche', protocol_key: 'benqi-staking', kind: 'staking', config: { staking: '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE', sAvax: '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE' }, enabled: true, updated_by: 'smoke' })
refreshProtocolCache(await listChainProtocols())
assert(listSkills('avalanche').some((s) => s.id === 'defi-staking'), '恢复后主网清单应重新出现 defi-staking')
ok('协议停用/恢复 → 技能显隐联动')

// 4. 工具装配:owner 模式有 propose_stake + staking_status;social 模式无(scope=owner);fuji 装不上
const TOKEN = 777777
await installSkill('avalanche', TOKEN, 'defi-staking')
const ownerTools = await getToolsFor('avalanche', TOKEN, 'owner')
assert('propose_stake' in ownerTools && 'staking_status' in ownerTools, 'owner 模式应有 propose_stake/staking_status')
const socialTools = await getToolsFor('avalanche', TOKEN, 'social')
assert(!('propose_stake' in socialTools) && !('staking_status' in socialTools), 'social 模式不应有质押工具')
let rejected = false
try {
  await installSkill('fuji', TOKEN, 'defi-staking')
} catch {
  rejected = true
}
assert(rejected, 'fuji 应拒绝安装 defi-staking')
await uninstallSkill('avalanche', TOKEN, 'defi-staking')
ok('工具装配: owner 有质押工具 / social 无 / fuji 拒绝安装')

// 5. 策略引擎白名单:staking action 走 BENQI 合约白名单;伪造协议被拒
const good = await evaluateProposal('avalanche', {
  action: 'staking',
  protocol: benqiCfg('avalanche').staking,
  chainId: 43114,
  executionMode: 'hot_wallet',
  params: { tokenIn: 'native', tokenOut: benqiCfg('avalanche').sAvax, amountIn: parseEther('0.1').toString() },
  estimatedValueUsd: 3,
  reason: 'smoke',
})
assert(good.verdict !== 'rejected', `合法质押提案不应被拒: ${good.reasons.join(';')}`)
const bad = await evaluateProposal('avalanche', {
  action: 'staking',
  protocol: '0x00000000000000000000000000000000000bad01',
  chainId: 43114,
  executionMode: 'hot_wallet',
  params: { tokenIn: 'native', tokenOut: benqiCfg('avalanche').sAvax, amountIn: parseEther('0.1').toString() },
  estimatedValueUsd: 3,
  reason: 'smoke',
})
assert(bad.verdict === 'rejected', '伪造质押合约地址应被白名单拒绝')
// fuji 目标链的质押提案:链在白名单但无 benqi 配置 → 硬拒
const fujiTarget = await evaluateProposal('fuji', {
  action: 'staking',
  protocol: benqiCfg('avalanche').staking,
  chainId: 43113,
  executionMode: 'hot_wallet',
  params: { tokenIn: 'native', tokenOut: benqiCfg('avalanche').sAvax, amountIn: parseEther('0.1').toString() },
  estimatedValueUsd: 3,
  reason: 'smoke',
})
assert(fujiTarget.verdict === 'rejected', 'fuji 目标链的质押提案应被硬拒')
ok('策略引擎: staking 白名单通过 / 伪造地址拒绝 / fuji 目标链硬拒')

// 6. 主网真实只读:汇率/cooldown/报价(不发交易)
const client = getPublicClient('avalanche')
await client.getBlockNumber() // 主网可达性
const info = await fetchStakingInfo('avalanche', '0x000000000000000000000000000000000000dEaD' as Address)
const rate = Number(info.avaxPerSavax)
assert(rate > 1 && rate < 3, `1 sAVAX 应兑 1~3 AVAX(质押有收益),实际 ${info.avaxPerSavax}`)
assert(info.cooldownDays === 15, `cooldown 应为 15 天,实际 ${info.cooldownDays}`)
const shares = await quoteStake('avalanche', parseEther('0.1'))
assert(shares > 0n && Number(formatEther(shares)) < 0.1, `0.1 AVAX 应换得 0~0.1 sAVAX(汇率>1),实际 ${formatEther(shares)}`)
console.log(`   主网实况: 1 sAVAX = ${info.avaxPerSavax} AVAX, cooldown = ${info.cooldownDays} 天, 0.1 AVAX ≈ ${formatEther(shares)} sAVAX`)
ok('主网只读: 汇率/cooldown/报价与链上核实一致')

await closeDb()
fs.rmSync(DATA_DIR, { recursive: true, force: true })
console.log(`\n全部通过(${passed} 项)`)
