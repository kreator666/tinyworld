// 一次性冒烟验证:技能注册表无回归(第二阶段 C 配套)
// 覆盖: ensureDefaultSkills 按链家族过滤 / installSkill 拒绝不可用技能 /
//       协议停用后 getToolsFor 不加载工具 + getInstalledManifests 不进能力摘要
// 用法: npx tsx scripts/verify-skill-registry.ts(自带独立数据目录)
import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = path.resolve(process.cwd(), 'data-smoke-skill-registry').replaceAll('\\', '/')
fs.rmSync(DATA_DIR, { recursive: true, force: true })
process.env.AGENT_DATA_DIR = DATA_DIR

const { initSchema, closeDb, listChains, loadChainConfigsFromDb, listChainProtocols, upsertChainProtocol } = await import('../src/db')
const { applyDbChains, applyDbChainConfigs } = await import('../src/chain/registry')
const { seedChainProtocols } = await import('../src/skills/protocolSeeding')
const { ensureDefaultSkills, installSkill, uninstallSkill, getInstalledSkills, getInstalledManifests, getToolsFor, syncSkillsToDb, refreshProtocolCache } =
  await import('../src/skills')

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`断言失败: ${msg}`)
}
let passed = 0
function ok(msg: string): void {
  passed++
  console.log(`✅ ${msg}`)
}

const FUJI = 'fuji'
const SOLANA = 'solana-devnet'
const TOKEN = 424242

await initSchema()
applyDbChains(await listChains())
applyDbChainConfigs(await loadChainConfigsFromDb())
await seedChainProtocols()
refreshProtocolCache(await listChainProtocols())
await syncSkillsToDb()

// 1. 默认安装:EVM 链装 defi-swap/defi-lending,不装 solanaOnly 的 meteora;Solana 链相反
const addedFuji = await ensureDefaultSkills(FUJI, TOKEN)
assert(addedFuji.includes('defi-swap') && addedFuji.includes('defi-lending'), `fuji 默认安装应含 defi-swap/defi-lending: ${addedFuji}`)
assert(!addedFuji.includes('defi-swap-meteora'), 'fuji 不应装 solanaOnly 的 defi-swap-meteora')
const addedSol = await ensureDefaultSkills(SOLANA, TOKEN)
assert(addedSol.includes('defi-swap-meteora'), `solana-devnet 默认安装应含 defi-swap-meteora: ${addedSol}`)
assert(!addedSol.includes('defi-swap'), 'solana-devnet 不应装 evmOnly 的 defi-swap')
// 幂等:再跑一遍不重复装
const again = await ensureDefaultSkills(FUJI, TOKEN)
assert(again.length === 0, `默认安装应幂等,实际重复安装: ${again}`)
ok('ensureDefaultSkills:按链家族过滤 + 幂等')

// 2. 安装校验:清单层 disabled 技能不可安装;未知技能报错
let rejected = false
try {
  await installSkill(SOLANA, TOKEN, 'defi-swap-orca')
} catch {
  rejected = true
}
assert(rejected, 'disabled 技能 defi-swap-orca 应拒绝安装')
ok('installSkill:disabled 技能拒绝安装')

// 3. 协议停用 → 工具不加载 + 能力摘要不包含(已安装但当前不可用的技能)
const toolsFuji = await getToolsFor(FUJI, TOKEN)
assert('propose_swap' in toolsFuji, 'fuji 默认工具集应有 propose_swap(defi-swap)')
const manifestsFuji = await getInstalledManifests(FUJI, TOKEN)
assert(manifestsFuji.some((m) => m.id === 'defi-swap'), '能力摘要应有 defi-swap')
await upsertChainProtocol({ chain_key: FUJI, protocol_key: 'dex', kind: 'dex', config: {}, enabled: false, updated_by: 'smoke' })
refreshProtocolCache(await listChainProtocols())
const toolsFuji2 = await getToolsFor(FUJI, TOKEN)
assert(!('propose_swap' in toolsFuji2), '停用 dex 后工具集不应再加载 propose_swap')
assert('propose_supply' in toolsFuji2, 'lending 未停用,propose_supply 仍应在')
const manifestsFuji2 = await getInstalledManifests(FUJI, TOKEN)
assert(!manifestsFuji2.some((m) => m.id === 'defi-swap'), '能力摘要不应再含 defi-swap')
assert(manifestsFuji2.some((m) => m.id === 'defi-lending'), 'defi-lending 不受影响')
// 安装记录本身仍在(DB 不删),恢复协议后工具回来了
const installedStill = await getInstalledSkills(FUJI, TOKEN)
assert(installedStill.some((s) => s.id === 'defi-swap'), '安装记录不因协议停用而删除')
await upsertChainProtocol({ chain_key: FUJI, protocol_key: 'dex', kind: 'dex', config: { router: '0xrestored' }, enabled: true, updated_by: 'smoke' })
refreshProtocolCache(await listChainProtocols())
const toolsFuji3 = await getToolsFor(FUJI, TOKEN)
assert('propose_swap' in toolsFuji3, '恢复 dex 后 propose_swap 应重新加载')
ok('getToolsFor/getInstalledManifests:协议停用 → 工具与能力摘要同步隐藏,恢复即回来,安装记录保留')

// 4. 卸载
const removed = await uninstallSkill(FUJI, TOKEN, 'defi-swap')
assert(removed, '卸载 defi-swap 应成功')
assert(!(await getInstalledSkills(FUJI, TOKEN)).some((s) => s.id === 'defi-swap'), '卸载后安装记录应消失')
ok('uninstallSkill 正常')

await closeDb()
fs.rmSync(DATA_DIR, { recursive: true, force: true })
console.log(`\n全部通过(${passed} 项)`)
