import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import type { SkillDef } from '../../../src/skills/registry'
import { generateSkill, installGeneratedSkill } from './generator'

// ============================================================
// 内置技能 skill-creator(M5):
// 允许 Agent owner 通过聊天描述需求,自动生成一个 Python 技能。
// 一期权限:仅当前 Agent 的 owner 可使用(通过 scope='owner' 限制);
// 二期改由链上 PERMISSION_SKILL 权限位控制。
// ============================================================

function makeCreateSkillTool(chainKey: string, tokenId: number) {
  return createTool({
    id: 'create_skill',
    description:
      '根据主人的自然语言描述,自动生成一个 Python 技能并安装到当前 Agent。示例:"我想加一个查天气的技能,输入城市名返回温度和天气状况"。生成前会请求主人确认。',
    inputSchema: z.object({
      description: z.string().describe('你想让新技能做什么,尽量具体'),
      name: z.string().optional().describe('技能显示名称(可选,缺省由 Agent 自动生成)'),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      skillId: z.string().optional(),
      name: z.string().optional(),
      error: z.string().optional(),
      note: z.string().optional(),
    }),
    execute: async ({ context }) => {
      if (!context.description?.trim()) {
        return { ok: false, error: '描述不能为空' }
      }
      try {
        const generated = await generateSkill(context.description.trim(), chainKey, tokenId)
        await installGeneratedSkill(generated, chainKey, tokenId)

        return {
          ok: true,
          skillId: generated.skillId,
          name: generated.name,
          note: `已生成并安装技能 ${generated.name}。注意:该技能目前只能读取/处理信息,禁止转账或修改链上状态。如需调整,可删除后重新生成。`,
        }
      } catch (e) {
        console.error('[skill-creator] 生成技能失败:', e)
        return { ok: false, error: (e as Error).message }
      }
    },
  })
}

export const skillCreator: SkillDef = {
  manifest: {
    id: 'skill-creator',
    name: '技能生成器',
    version: '0.1.0',
    description: '允许 Agent owner 通过自然语言描述自动生成并安装 Python 技能(一期仅 owner 可用,二期由链上 PERMISSION_SKILL 控制)',
    tools: ['create_skill'],
    permissions: [],
    scope: 'owner',
    runtime: 'typescript',
    entry: 'index.ts',
    source: 'builtin',
  },
  makeTools: (chainKey, tokenId) => ({
    create_skill: makeCreateSkillTool(chainKey, tokenId),
  }),
}
