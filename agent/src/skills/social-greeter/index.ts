import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { getDb } from '../../db'
import { listRecentAgents, loadPersona } from '../../chain/persona'
import { complete } from '../../core/llm'
import type { SkillDef } from '../registry'

// ============================================================
// 内置技能 social-greeter(需要链上 social 权限):
// 发现新铸造的 Agent 并起草打招呼文案——M2 只产草稿,真实发送是 M3 的事
// ============================================================

const listNewAgents = createTool({
  id: 'list_new_agents',
  description: '列出链上最新铸造的 Agent(编号、名字、主人地址),用于发现新朋友',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(20).default(5).describe('返回几个最新的 Agent'),
  }),
  outputSchema: z.object({
    agents: z.array(z.object({ tokenId: z.number(), name: z.string(), owner: z.string() })),
  }),
  execute: async ({ context }) => {
    return { agents: await listRecentAgents(context.limit) }
  },
})

/** draft_greeting 闭包绑定 tokenId:按当前人格生成草稿,并把触发记录写 tasks 表 */
function makeDraftGreeting(tokenId: number) {
  return createTool({
    id: 'draft_greeting',
    description: '为指定的 Agent 起草一段打招呼文案(只生成草稿,不会真实发送)',
    inputSchema: z.object({
      agentName: z.string().describe('对方 Agent 的名字'),
    }),
    outputSchema: z.object({ draft: z.string() }),
    execute: async ({ context }) => {
      const persona = await loadPersona(tokenId)
      const { profile } = persona
      const draft = await complete(
        [
          `你是「${persona.name}」在链上的 AI 分身,性格:${profile.personality || '随和'},语气风格:${profile.tone}。`,
          `请为新认识的 Agent「${context.agentName}」写一段主动打招呼的文案,第一人称,简短自然,像真人发消息,不要使用 markdown。`,
        ].join('\n'),
        `给「${context.agentName}」的打招呼草稿`,
      )

      // 触发记录落 tasks 表(审计,设计文档 §11.4)
      const db = await getDb()
      await db.query('INSERT INTO tasks (id, token_id, type, status, payload, result) VALUES ($1, $2, $3, $4, $5, $6)', [
        randomUUID(),
        tokenId,
        'social',
        'drafted',
        JSON.stringify({ skill: 'social-greeter', tool: 'draft_greeting', target: context.agentName }),
        JSON.stringify({ draft }),
      ])
      return { draft }
    },
  })
}

export const socialGreeter: SkillDef = {
  manifest: {
    id: 'social-greeter',
    name: '主动社交',
    version: '0.1.0',
    description: '向新铸造 Agent 的主人主动打招呼、破冰聊天(M2 只产出草稿)',
    tools: ['list_new_agents', 'draft_greeting'],
    permissions: ['social'],
  },
  makeTools: (tokenId) => ({
    list_new_agents: listNewAgents,
    draft_greeting: makeDraftGreeting(tokenId),
  }),
}
