import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { addOwnerFact, FACT_CATEGORIES, listOwnerFacts, removeOwnerFact, type FactSensitivity } from '../../core/ownerFacts'
import { invalidateAgent } from '../../core/agent'
import type { SkillDef } from '../registry'

// ============================================================
// 内置技能 owner-tuning(M5 调教,scope=owner 仅主人对话):
// Agent 与主人聊天中学习主人的喜好/习惯/个人信息,写入 owner_facts(带隐私分级);
// 主人要求遗忘时可删除。社交对话中 Agent 会通过 system prompt 里的
// 公开画像(仅 general/coarse)自然体现主人的特点。
// 隐私硬规则在 core/ownerFacts.ts 写入侧兜底(精确地址拒写等)。
// ============================================================

const SENSITIVITY_DESC =
  '隐私级别:general=可对外分享(如"喜欢猫");coarse=对外只可用概略形态(如"住在上海"、"王先生");private=仅限主人对话(精确住址、电话、财务等)'

/** remember_owner_fact 闭包绑定 tokenId */
function makeRememberOwnerFact(tokenId: number) {
  return createTool({
    id: 'remember_owner_fact',
    description: `记住一条关于主人的事实(喜好/习惯/个人信息等)。写入前必须想清楚隐私级别:${SENSITIVITY_DESC}。位置只能记到城市或区县(如"住在上海"),姓名只能记姓氏加称呼(如"王先生");门牌号、小区名、电话、身份证这类精确信息若要记,必须标 private。写入成功后社交对话里会自然体现出来。`,
    inputSchema: z.object({
      fact: z.string().describe('要记下的事实,一句话,如"主人喜欢喝美式咖啡"、"主人住在上海"'),
      category: z.enum(FACT_CATEGORIES).describe('事实分类'),
      sensitivity: z.enum(['general', 'coarse', 'private']).describe(SENSITIVITY_DESC),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      id: z.string().optional(),
      fact: z.string().optional(),
      error: z.string().optional(),
    }),
    execute: async ({ context }) => {
      try {
        const saved = await addOwnerFact(tokenId, context)
        invalidateAgent(tokenId) // 社交/主人 Agent 实例重建,带上新画像
        return { ok: true, id: saved.id, fact: `[${saved.category}/${saved.sensitivity}] ${saved.fact}` }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
  })
}

/** list_owner_facts:主人模式可见全部(含 private),供 Agent 回顾自己记住了什么 */
function makeListOwnerFacts(tokenId: number) {
  return createTool({
    id: 'list_owner_facts',
    description: '列出你已经记住的关于主人的全部事实(含隐私级别)。主人问"你记住了我什么"时使用。',
    inputSchema: z.object({}),
    outputSchema: z.object({
      facts: z.array(z.object({ id: z.string(), category: z.string(), fact: z.string(), sensitivity: z.string() })),
    }),
    execute: async () => {
      const facts = await listOwnerFacts(tokenId)
      return { facts: facts.map((f) => ({ id: f.id, category: f.category, fact: f.fact, sensitivity: f.sensitivity })) }
    },
  })
}

/** forget_owner_fact:主人主权——按关键词删除(支持 id 前缀或内容模糊匹配) */
function makeForgetOwnerFact(tokenId: number) {
  return createTool({
    id: 'forget_owner_fact',
    description: '忘掉一条关于主人的事实。主人说"忘掉我喜欢咖啡"之类时,传入能定位到那条事实的关键词。',
    inputSchema: z.object({
      keyword: z.string().describe('要删除事实的关键词(匹配事实内容,或事实 id 前缀)'),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      removed: z.number(),
      error: z.string().optional(),
    }),
    execute: async ({ context }) => {
      const keyword = context.keyword.trim()
      if (!keyword) return { ok: false, removed: 0, error: '关键词不能为空' }
      const removed = await removeOwnerFact(tokenId, keyword)
      if (removed > 0) invalidateAgent(tokenId)
      return { ok: removed > 0, removed }
    },
  })
}

export const ownerTuning: SkillDef = {
  manifest: {
    id: 'owner-tuning',
    name: '主人调教',
    version: '0.1.0',
    description:
      '与主人聊天中学习主人的喜好、习惯和个人信息(带隐私分级:可对外/概略/仅主人),主人可查看或要求遗忘;学到的特点会在社交对话中自然体现,敏感信息(全名、精确地址等)不会对外泄露。',
    tools: ['remember_owner_fact', 'list_owner_facts', 'forget_owner_fact'],
    permissions: [], // 纯本地记忆写入,不触链
    scope: 'owner', // 学习/查看/遗忘仅限主人对话
  },
  makeTools: (tokenId) => ({
    remember_owner_fact: makeRememberOwnerFact(tokenId),
    list_owner_facts: makeListOwnerFacts(tokenId),
    forget_owner_fact: makeForgetOwnerFact(tokenId),
  }),
}
