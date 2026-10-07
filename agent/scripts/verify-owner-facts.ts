// 一次性验证:主人画像(M5 调教)存储层 + 隐私硬规则
import { initSchema, closeDb } from '../src/db'
import { config } from '../src/config'
import { addOwnerFact, listOwnerFacts, removeOwnerFact, buildShareableProfile } from '../src/core/ownerFacts'

const TOKEN = 999999 // 测试用不存在的 tokenId,验证完清理
const CHAIN = config.chainKey // 跟随 TARGET_CHAIN(单链时代数据都在默认链)

await initSchema()

// 1. 正常写入:三个级别各一条
await addOwnerFact(CHAIN, TOKEN, { category: '喜好', fact: '主人喜欢喝美式咖啡', sensitivity: 'general' })
await addOwnerFact(CHAIN, TOKEN, { category: '位置', fact: '主人住在上海', sensitivity: 'coarse' })
await addOwnerFact(CHAIN, TOKEN, { category: '个人信息', fact: '主人的手机号是 138xxxx0000', sensitivity: 'private' })

// 2. 隐私硬规则:精确地址以 coarse 写入必须被拒
let guarded = false
try {
  await addOwnerFact(CHAIN, TOKEN, { category: '位置', fact: '主人住在上海市浦东新区世纪大道100号环球金融中心', sensitivity: 'coarse' })
} catch (e) {
  guarded = true
  console.log('✅ 精确地址被拒:', (e as Error).message.slice(0, 40), '…')
}
if (!guarded) throw new Error('隐私硬规则失效:精确地址写入了!')

// 3. private 级别不受地址规则限制(主人自己可见)
await addOwnerFact(CHAIN, TOKEN, { category: '位置', fact: '精确地址(仅主人可见):世纪大道100号', sensitivity: 'private' })

// 4. 列表:全量 4 条;coarse 可见 2 条
const all = await listOwnerFacts(CHAIN, TOKEN)
const coarse = await listOwnerFacts(CHAIN, TOKEN, 'coarse')
console.log(`全量 ${all.length} 条(期望 4),coarse 可见 ${coarse.length} 条(期望 2)`)
if (all.length !== 4 || coarse.length !== 2) throw new Error('分级可见性不对')

// 5. 社交画像不含 private
const profile = await buildShareableProfile(CHAIN, TOKEN)
console.log('--- 社交画像 ---')
console.log(profile)
if (profile.includes('138') || profile.includes('世纪大道')) throw new Error('private 信息泄露到社交画像!')

// 6. 遗忘
const removed = await removeOwnerFact(CHAIN, TOKEN, '美式咖啡')
const after = await listOwnerFacts(CHAIN, TOKEN)
console.log(`遗忘 "美式咖啡":删除 ${removed} 条,剩余 ${after.length} 条(期望 3)`)
if (removed !== 1 || after.length !== 3) throw new Error('遗忘失败')

// 7. 清理测试数据
for (const f of after) await removeOwnerFact(CHAIN, TOKEN, f.id)
console.log('剩余测试数据已清理:', (await listOwnerFacts(CHAIN, TOKEN)).length, '条')

await closeDb()
console.log('ownerFacts 验证通过 ✅')
