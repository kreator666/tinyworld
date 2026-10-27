import { embed } from './embedding'
import { insertArenaMemory, retrieveArenaMemories, listArenaMemories, type ArenaMemoryRow } from '../db/arena'

// ============================================================
// 竞技场专用记忆层(P4+):与聊天 memories 隔离,服务 Thinker/Executor
// - episodic:每次决策/执行的原始记录
// - semantic:蒸馏出的策略偏好/经验教训
// ============================================================

/** number[] → pgvector 字面量 '[0.1,0.2,...]' */
function toVectorLiteral(v: number[]): string {
  return `[${v.map((n) => n.toFixed(6)).join(',')}]`
}

/** 写一条竞技场记忆 */
export async function writeArenaMemory(
  chainKey: string,
  tokenId: number,
  seasonId: string | null,
  kind: 'episodic' | 'semantic',
  content: string,
): Promise<void> {
  const vec = kind === 'semantic' ? toVectorLiteral(await embed(content)) : null
  await insertArenaMemory({ chain_key: chainKey, token_id: String(tokenId), season_id: seasonId, kind, content, embedding: vec })
}

/** 检索竞技场记忆:语义 topK + 最近 episodic */
export async function retrieveArenaMemory(
  chainKey: string,
  tokenId: number,
  query: string,
  semanticK = 5,
  episodicK = 3,
): Promise<string> {
  const vec = toVectorLiteral(await embed(query))
  const { semantic, episodic } = await retrieveArenaMemories(chainKey, tokenId, vec, semanticK, episodicK)
  const sections: string[] = []
  if (semantic.length > 0) {
    sections.push('长期策略记忆:\n' + semantic.map((s) => '- ' + s).join('\n'))
  }
  if (episodic.length > 0) {
    sections.push('近期决策流水:\n' + episodic.map((s) => '- ' + s.replace(/\n/g, ' / ')).join('\n'))
  }
  if (sections.length === 0) return ''
  return '以下是你在这场竞技赛中记得的事:\n' + sections.join('\n\n')
}

/** 浏览竞技场记忆(调试用) */
export async function getArenaMemories(chainKey: string, tokenId: number, kind?: 'episodic' | 'semantic', limit = 50): Promise<ArenaMemoryRow[]> {
  return listArenaMemories(chainKey, tokenId, kind, limit)
}
