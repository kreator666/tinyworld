import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { complete } from '../../../src/core/llm'
import { getUserSkillDir } from '../../../src/skills/loader'
import { installSkill, syncSkillsToDb } from '../../../src/skills/registry'
import { reloadSkills } from '../../../src/skills'

// ============================================================
// 用户技能代码生成器(M5):
// 把自然语言需求转成 Python 技能代码 + skill.json。
// 目前基于系统模板 + LLM 填空,保证生成代码符合 stdio JSON Lines 协议。
// ============================================================

const PYTHON_TEMPLATE = readFileSync(
  join(import.meta.dirname ?? __dirname, 'templates', 'python-skill.py'),
  'utf-8',
)

export interface GeneratedSkill {
  skillId: string
  name: string
  description: string
  toolName: string
  toolDescription: string
  inputSchema: Record<string, unknown>
  pythonCode: string
  skillJson: Record<string, unknown>
}

/** 把自然语言描述转成合法的 skill id(snake-case) */
function toSkillId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'custom-skill'
}

/** 生成唯一 skill id,避免跨 Agent/跨会话冲突 */
function makeSkillId(chainKey: string, tokenId: number, description: string): string {
  const base = `${chainKey}-${tokenId}-${toSkillId(description)}-${Date.now()}`
  // 目录名安全:去掉可能的多余连字符并截断
  return base.replace(/-+/g, '-').slice(0, 64)
}

/** 用 LLM 从用户描述中同时提取元数据和 Python 实现 */
async function extractSkillSpec(description: string): Promise<{
  name: string
  skillDescription: string
  toolName: string
  toolDescription: string
  inputSchema: Record<string, unknown>
  implementation: string
}> {
  const prompt = `你是一名智能助手技能设计师。用户想用自然语言为 Agent 添加一个自定义 Python 技能。

用户描述:
"""
${description}
"""

请仅返回一个 JSON 对象(不要 markdown 代码块,不要多余解释),字段如下:
{
  "name": "技能的简短中文名称(5字以内)",
  "skillDescription": "这个技能能做什么,一句话",
  "toolName": "工具英文名,小写下划线,如 get_weather / search_news",
  "toolDescription": "Agent 调用该工具时会看到的详细说明,包含参数含义",
  "inputSchema": { "type": "object", "properties": { "参数名": { "type": "string", "description": "..." } }, "required": ["参数名"] },
  "implementation": "Python 函数体(4空格缩进),从 args 读取参数,返回 dict。只能使用 Python 标准库;需要 HTTP 时可调用 safe_http_get(url)。禁止转账、授权、修改链上状态。"
}

注意:
- 工具只能读取信息或执行安全操作;
- inputSchema 参数名必须与 implementation 中从 args.get('参数名') 读取的一致;
- implementation 不要包含函数定义行 def ...:,只写函数体;
- 如果描述不清晰,默认做成"查询/获取信息"类工具。`

  const raw = await complete(prompt, '设计用户自定义技能')
  try {
    const json = raw.replace(/^```json\s*|\s*```$/g, '').trim()
    const parsed = JSON.parse(json) as {
      name: string
      skillDescription: string
      toolName: string
      toolDescription: string
      inputSchema: Record<string, unknown>
      implementation: string
    }
    return parsed
  } catch (e) {
    console.warn('[skill-creator] LLM 元数据解析失败,使用默认值:', e, '\n原始输出:', raw)
    return {
      name: '自定义技能',
      skillDescription: description,
      toolName: 'run_custom_skill',
      toolDescription: `执行用户自定义技能: ${description}`,
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: '用户输入' } }, required: ['query'] },
      implementation: '    query = args.get("query", "")\n    return {"result": f"收到请求: {query}"}',
    }
  }
}

/** 生成完整技能包 */
export async function generateSkill(
  description: string,
  chainKey: string,
  tokenId: number,
  createdBy?: string,
): Promise<GeneratedSkill> {
  const meta = await extractSkillSpec(description)
  const skillId = makeSkillId(chainKey, tokenId, description)

  const inputSchema: Record<string, unknown> =
    meta.inputSchema && typeof meta.inputSchema === 'object' && meta.inputSchema.type === 'object'
      ? meta.inputSchema
      : { type: 'object', properties: { query: { type: 'string', description: '查询内容' } }, required: ['query'] }

  const pythonCode = PYTHON_TEMPLATE
    .replace(/\{\{tool_name\}\}/g, meta.toolName)
    .replace(/\{\{tool_description\}\}/g, meta.toolDescription.replace(/"/g, '\\"'))
    .replace(/\{\{input_schema\}\}/g, JSON.stringify(inputSchema))
    .replace(/\{\{implementation\}\}/g, meta.implementation)

  const skillJson = {
    id: skillId,
    name: meta.name,
    version: '0.1.0',
    description: meta.skillDescription,
    tools: [meta.toolName],
    permissions: [],
    scope: 'owner',
    runtime: 'python',
    entry: 'index.py',
    source: 'user',
    ownerAgent: { chainKey, tokenId },
    ...(createdBy ? { createdBy } : {}),
  }

  return {
    skillId,
    name: meta.name,
    description: meta.skillDescription,
    toolName: meta.toolName,
    toolDescription: meta.toolDescription,
    inputSchema,
    pythonCode,
    skillJson,
  }
}

/** 将生成好的技能落盘、热重载并安装到指定 Agent */
export async function installGeneratedSkill(
  generated: GeneratedSkill,
  chainKey: string,
  tokenId: number,
): Promise<void> {
  const dir = getUserSkillDir(generated.skillId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(generated.skillJson, null, 2) + '\n')
  writeFileSync(join(dir, 'index.py'), generated.pythonCode)
  await reloadSkills()
  await syncSkillsToDb()
  await installSkill(chainKey, tokenId, generated.skillId)
}
