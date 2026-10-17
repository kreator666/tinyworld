import { clearSkills, registerSkill } from './registry'
import { loadAllSkills } from './loader'

// ============================================================
// 技能启动入口(M5):
// 不再硬编码 import 每个技能,改由 loader 扫描 runtime-skills/ 目录动态加载。
// 新增/删除/修改技能只需操作 runtime-skills/builtins/ 或 runtime-skills/user/ 目录,
// 无需改动本文件,也无需重新编译整个 agent 服务(重启或热重载即可)。
// ============================================================

let loaded = false

/** 同步加载全部 runtime-skills/ 目录下的技能;幂等,重复调用跳过 */
export async function loadSkills(): Promise<void> {
  if (loaded) return
  const skills = await loadAllSkills()
  for (const skill of skills) {
    registerSkill({ manifest: skill.manifest, makeTools: skill.makeTools })
  }
  loaded = true
  console.log(`[skills] 已加载 ${skills.length} 个技能`)
}

/** 热重载全部 runtime-skills/ 目录;用于生成/删除用户技能后即时生效 */
export async function reloadSkills(): Promise<void> {
  clearSkills()
  loaded = false
  await loadSkills()
}

export * from './registry'
export * from './loader'
