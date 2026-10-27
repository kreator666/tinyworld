import { getInstalledManifests } from '../skills/registry'

// ============================================================
// 竞技场技能目录(P4+):把 agent 已安装的公共技能变成 Thinker 的知识库
// 只读,不执行;执行仍由 ArenaExecutor 的 ARENA_ACTIONS 负责
// ============================================================

/** 生成给 LLM 的文本化技能目录 */
export async function buildSkillCatalog(chainKey: string, tokenId: number): Promise<string> {
  const manifests = await getInstalledManifests(chainKey, tokenId)
  if (manifests.length === 0) return '当前没有已安装的公共技能。'
  return manifests
    .map((m) => {
      const tools = m.tools.map((t) => `  - ${t}`).join('\n')
      return `技能: ${m.name} (id=${m.id})\n描述: ${m.description}\n可用工具:\n${tools}`
    })
    .join('\n\n')
}
