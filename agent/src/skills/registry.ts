import type { Address } from 'viem'
import { isAddress } from 'viem'
import type { createTool } from '@mastra/core/tools'
import { getDb } from '../db'
import { config } from '../config'
import { PERMISSION_SOCIAL, getAgentPermissions } from '../chain/persona'
import { getChainContext } from '../chain/registry'
import { isMeteoraSwapConfigured } from '../chain/meteora'

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
  /** 工具可用范围:social=仅社交对话,owner=仅主人对话,all=两者(默认) */
  scope?: 'social' | 'owner' | 'all'
  /** 仅 EVM 家族链可用(Solana 下从清单/默认安装/工具集里隐藏,如 defi-swap/defi-lending) */
  evmOnly?: boolean
  /** 仅 Solana 家族链可用(如 defi-swap-solana/defi-swap-meteora);后端是否就绪由 chainFeature 判断 */
  solanaOnly?: boolean
  /** Solana 技能的后端依赖:jupiterApi = 需 cfg.solana.jupiterApiUrl;meteoraPool = 需热钱包私钥 + Meteora 池地址 */
  chainFeature?: 'jupiterApi' | 'meteoraPool'
  /** 清单层禁用(如协议程序未部署到当前环境):不出现在清单/安装/工具集,工具 execute 仍兜底提示 */
  disabled?: boolean
}

export interface SkillDef {
  manifest: SkillManifest
  /** 为指定链上的 tokenId 构造该技能的 Mastra 工具集(工具内闭包绑定 chainKey + tokenId) */
  makeTools: (chainKey: string, tokenId: number) => Record<string, AnyTool>
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

/** 技能在指定链家族是否可用(evmOnly 技能在 Solana 下不可用;solanaOnly 技能要求 Solana 链,后端就绪由 chainFeature 判断;disabled 技能全链隐藏) */
export function isSkillAvailable(chainKey: string, manifest: SkillManifest): boolean {
  if (manifest.disabled) return false
  const ctx = getChainContext(chainKey)
  if (manifest.evmOnly && ctx.family !== 'evm') return false
  if (manifest.solanaOnly) {
    if (ctx.family !== 'solana') return false
    if (manifest.chainFeature === 'jupiterApi' && !ctx.cfg.solana?.jupiterApiUrl) return false
    if (manifest.chainFeature === 'meteoraPool' && !isMeteoraSwapConfigured()) return false
  }
  return true
}

/** 全部可安装技能(清单);Solana 链下隐藏 evmOnly 技能 */
export function listSkills(chainKey: string): SkillManifest[] {
  return [...builtins.values()].map((d) => d.manifest).filter((m) => isSkillAvailable(chainKey, m))
}

/** 随 Agent 运行时默认启用的一组内置技能(新 Agent 首次装载时自动安装,无需主人手动装)。
 *  注意:defi-swap-meteora / defi-perp-drift 是 solanaOnly——ensureDefaultSkills 会按链家族
 *  自动跳过不可用项;二者都在主网执行(split-brain,见 chain/solanaExec.ts)。 */
export const DEFAULT_SKILL_IDS = ['social-greeter', 'defi-quote', 'defi-swap', 'defi-lending', 'defi-swap-meteora', 'defi-perp-drift', 'owner-tuning']

/**
 * 确保默认技能已安装(幂等):比对 DB 里现有安装记录,只补缺口。
 * 每次都以 DB 为准,所以主人手动卸载后不会反复装回(重启服务也尊重卸载)。
 * 返回本次新安装的技能 id 列表(空数组 = 原本已齐全)。
 */
export async function ensureDefaultSkills(chainKey: string, tokenId: number): Promise<string[]> {
  const db = await getDb()
  const res = await db.query<{ skill_id: string }>('SELECT skill_id FROM agent_skills WHERE chain_key = $1 AND token_id = $2', [chainKey, tokenId])
  const installed = new Set(res.rows.map((r) => r.skill_id))
  const added: string[] = []
  for (const skillId of DEFAULT_SKILL_IDS) {
    if (installed.has(skillId) || !builtins.has(skillId)) continue
    const def = builtins.get(skillId)!
    if (!isSkillAvailable(chainKey, def.manifest)) continue // Solana 下跳过 evmOnly 默认技能
    await db.query('INSERT INTO agent_skills (chain_key, token_id, skill_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
      chainKey,
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
export async function getInstalledSkills(chainKey: string, tokenId: number): Promise<InstalledSkill[]> {
  const db = await getDb()
  const res = await db.query<InstalledSkill>(
    `SELECT s.id, s.name, s.version FROM agent_skills a
     JOIN skills s ON s.id = a.skill_id
     WHERE a.chain_key = $1 AND a.token_id = $2
     ORDER BY a.installed_at`,
    [chainKey, tokenId],
  )
  return res.rows
}

/** 已安装技能的 manifest 列表(含 description,供系统提示词生成能力摘要用;未匹配内置技能的跳过) */
export async function getInstalledManifests(chainKey: string, tokenId: number): Promise<SkillManifest[]> {
  const installed = await getInstalledSkills(chainKey, tokenId)
  return installed.map((s) => builtins.get(s.id)?.manifest).filter((m): m is SkillManifest => Boolean(m))
}

export interface InstallResult {
  manifest: SkillManifest
  // passed = 链上权限校验通过;skipped = 跳过校验(原因见 note);none = 无需权限
  permissionCheck: 'passed' | 'skipped' | 'none'
  note?: string
}

/** 安装技能:需要 social 权限的先查链上 agentPermissions 的 PERMISSION_SOCIAL 位 */
export async function installSkill(chainKey: string, tokenId: number, skillId: string): Promise<InstallResult> {
  const def = builtins.get(skillId)
  if (!def) throw new SkillError(`未知技能: ${skillId}`)
  if (!isSkillAvailable(chainKey, def.manifest)) {
    throw new SkillError(`技能 ${skillId} 在当前链 ${getChainContext(chainKey).cfg.name} 不可用(链家族或链配置不满足技能要求)`, 400)
  }

  let permissionCheck: InstallResult['permissionCheck'] = 'none'
  let note: string | undefined
  if (def.manifest.permissions.includes('social')) {
    const agentAddr = config.agentServiceAddress
    if (!agentAddr) {
      permissionCheck = 'skipped'
      note = '未配置 AGENT_SERVICE_ADDRESS,已跳过链上权限校验'
    } else {
      if (!isAddress(agentAddr)) throw new SkillError('AGENT_SERVICE_ADDRESS 不是合法地址')
      const perms = await getAgentPermissions(chainKey, tokenId, agentAddr as Address)
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
    'INSERT INTO agent_skills (chain_key, token_id, skill_id) VALUES ($1, $2, $3) ON CONFLICT (chain_key, token_id, skill_id) DO NOTHING',
    [chainKey, tokenId, skillId],
  )
  return { manifest: def.manifest, permissionCheck, note }
}

/** 卸载技能;返回是否确实存在该安装记录 */
export async function uninstallSkill(chainKey: string, tokenId: number, skillId: string): Promise<boolean> {
  const db = await getDb()
  const res = await db.query('DELETE FROM agent_skills WHERE chain_key = $1 AND token_id = $2 AND skill_id = $3 RETURNING skill_id', [
    chainKey,
    tokenId,
    skillId,
  ])
  return res.rows.length > 0
}

/** 该 Agent 当前可用的工具 = 已安装技能的工具合并,并按对话模式过滤
 *  mode='owner'(默认):主人对话,可用含 DeFi/资产在内的全部工具
 *  mode='social'      :社交对话,仅加载 scope='social'|'all' 的技能,禁止资产/DeFi 操作
 */
export async function getToolsFor(
  chainKey: string,
  tokenId: number,
  mode: 'owner' | 'social' = 'owner',
): Promise<Record<string, AnyTool>> {
  const db = await getDb()
  const res = await db.query<{ skill_id: string }>('SELECT skill_id FROM agent_skills WHERE chain_key = $1 AND token_id = $2', [chainKey, tokenId])
  const tools: Record<string, AnyTool> = {}
  for (const { skill_id } of res.rows) {
    const def = builtins.get(skill_id)
    if (!def) continue // DB 里有但代码未注册(比如版本回滚),跳过
    if (!isSkillAvailable(chainKey, def.manifest)) continue // Solana 下 evmOnly 技能不加载工具
    const scope = def.manifest.scope ?? 'all'
    if (scope !== 'all' && scope !== mode) continue
    Object.assign(tools, def.makeTools(chainKey, tokenId))
  }
  return tools
}
