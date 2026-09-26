import type { Address } from 'viem'
import { isAddress } from 'viem'
import type { createTool } from '@mastra/core/tools'
import { getDb } from '../db'
import { config } from '../config'
import { PERMISSION_SOCIAL, getAgentPermissions } from '../chain/persona'

// ============================================================
// 技能注册表(设计文档 §5):技能 = 清单 + 一组 Mastra 工具
// M2 只支持"内置技能"(本地 TypeScript 工具);
// MCP Server 接入(M3+)预留:清单里加 transport 字段描述外部 MCP Server 的启动方式,
// 届时在 makeTools 处用 MCPClient 拉起 stdio/sse 连接并把远端工具并入工具集
// ============================================================

export type AnyTool = ReturnType<typeof createTool>

/** 技能清单(对应设计文档里的 skill.json;M2 直接以 TS 对象维护) */
export interface SkillManifest {
  id: string
  name: string
  version: string
  description: string
  tools: string[] // 工具 id 列表
  permissions: string[] // 'social' 等,对应链上 PERMISSION 位;空数组 = 只读技能无需授权
}

export interface SkillDef {
  manifest: SkillManifest
  /** 为指定 tokenId 构造该技能的 Mastra 工具集(工具内闭包绑定 tokenId) */
  makeTools: (tokenId: number) => Record<string, AnyTool>
}

export class SkillError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message)
  }
}

const builtins = new Map<string, SkillDef>()

export function registerSkill(def: SkillDef): void {
  builtins.set(def.manifest.id, def)
}

/** 全部可安装技能(清单) */
export function listSkills(): SkillManifest[] {
  return [...builtins.values()].map((d) => d.manifest)
}

/** 随 Agent 运行时默认启用的一组内置技能(新 Agent 首次装载时自动安装,无需主人手动装) */
export const DEFAULT_SKILL_IDS = ['social-greeter', 'defi-quote', 'defi-swap']

/**
 * 确保默认技能已安装(幂等):比对 DB 里现有安装记录,只补缺口。
 * 每次都以 DB 为准,所以主人手动卸载后不会反复装回(重启服务也尊重卸载)。
 * 返回本次新安装的技能 id 列表(空数组 = 原本已齐全)。
 */
export async function ensureDefaultSkills(tokenId: number): Promise<string[]> {
  const db = await getDb()
  const res = await db.query<{ skill_id: string }>('SELECT skill_id FROM agent_skills WHERE token_id = $1', [tokenId])
  const installed = new Set(res.rows.map((r) => r.skill_id))
  const added: string[] = []
  for (const skillId of DEFAULT_SKILL_IDS) {
    if (installed.has(skillId) || !builtins.has(skillId)) continue
    await db.query('INSERT INTO agent_skills (token_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      tokenId,
      skillId,
    ])
    added.push(skillId)
  }
  return added
}

/** 启动时把内置技能清单 upsert 进 skills 表 */
export async function syncSkillsToDb(): Promise<void> {
  const db = await getDb()
  for (const def of builtins.values()) {
    const m = def.manifest
    await db.query(
      `INSERT INTO skills (id, name, version, manifest) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version, manifest = EXCLUDED.manifest`,
      [m.id, m.name, m.version, JSON.stringify(m)],
    )
  }
}

export interface InstalledSkill {
  id: string
  name: string
  version: string
}

/** 该 Agent 已安装的技能(联表查清单) */
export async function getInstalledSkills(tokenId: number): Promise<InstalledSkill[]> {
  const db = await getDb()
  const res = await db.query<InstalledSkill>(
    `SELECT s.id, s.name, s.version FROM agent_skills a
     JOIN skills s ON s.id = a.skill_id
     WHERE a.token_id = $1
     ORDER BY a.installed_at`,
    [tokenId],
  )
  return res.rows
}

export interface InstallResult {
  manifest: SkillManifest
  // passed = 链上权限校验通过;skipped = 跳过校验(原因见 note);none = 无需权限
  permissionCheck: 'passed' | 'skipped' | 'none'
  note?: string
}

/** 安装技能:需要 social 权限的先查链上 agentPermissions 的 PERMISSION_SOCIAL 位 */
export async function installSkill(tokenId: number, skillId: string): Promise<InstallResult> {
  const def = builtins.get(skillId)
  if (!def) throw new SkillError(`未知技能: ${skillId}`)

  let permissionCheck: InstallResult['permissionCheck'] = 'none'
  let note: string | undefined
  if (def.manifest.permissions.includes('social')) {
    const agentAddr = config.agentServiceAddress
    if (!agentAddr) {
      permissionCheck = 'skipped'
      note = '未配置 AGENT_SERVICE_ADDRESS,已跳过链上权限校验'
    } else {
      if (!isAddress(agentAddr)) throw new SkillError('AGENT_SERVICE_ADDRESS 不是合法地址')
      const perms = await getAgentPermissions(tokenId, agentAddr as Address)
      if ((perms & PERMISSION_SOCIAL) === 0n) {
        throw new SkillError(
          `链上未授予 social 权限(PERMISSION_SOCIAL=2),请先调用 setAgent(${tokenId}, ${agentAddr}, 2) 授权`,
          403,
        )
      }
      permissionCheck = 'passed'
    }
  }
  // defi 权限:链上模块注册表(registerModule)本期未启用,跳过该校验;
  // 资金安全由策略引擎(限额/白名单/冷却/熔断/审批)兜底
  if (def.manifest.permissions.includes('defi')) {
    permissionCheck = 'skipped'
    note = '链上模块注册表本期未启用,defi 权限校验跳过,由策略引擎兜底'
  }

  const db = await getDb()
  await db.query(
    'INSERT INTO agent_skills (token_id, skill_id) VALUES ($1, $2) ON CONFLICT (token_id, skill_id) DO NOTHING',
    [tokenId, skillId],
  )
  return { manifest: def.manifest, permissionCheck, note }
}

/** 卸载技能;返回是否确实存在该安装记录 */
export async function uninstallSkill(tokenId: number, skillId: string): Promise<boolean> {
  const db = await getDb()
  const res = await db.query('DELETE FROM agent_skills WHERE token_id = $1 AND skill_id = $2 RETURNING skill_id', [
    tokenId,
    skillId,
  ])
  return res.rows.length > 0
}

/** 该 Agent 当前可用的全部工具 = 已安装技能的工具合并(调用方负责失效重建 Agent 实例) */
export async function getToolsFor(tokenId: number): Promise<Record<string, AnyTool>> {
  const db = await getDb()
  const res = await db.query<{ skill_id: string }>('SELECT skill_id FROM agent_skills WHERE token_id = $1', [tokenId])
  const tools: Record<string, AnyTool> = {}
  for (const { skill_id } of res.rows) {
    const def = builtins.get(skill_id)
    if (!def) continue // DB 里有但代码未注册(比如版本回滚),跳过
    Object.assign(tools, def.makeTools(tokenId))
  }
  return tools
}
