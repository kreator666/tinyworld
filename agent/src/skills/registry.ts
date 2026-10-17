import type { Address } from 'viem'
import { isAddress } from 'viem'
import type { createTool } from '@mastra/core/tools'
import { getDb, type ChainProtocolRow } from '../db'
import { config } from '../config'
import { PERMISSION_SOCIAL, getAgentPermissions } from '../chain/persona'
import { getChainContext } from '../chain/registry'
import { isMeteoraPoolConfigured } from '../chain/meteora'

// ============================================================
// 技能注册表(设计文档 §5):技能 = 清单 + 一组 Mastra 工具
// M2 只支持"内置技能"(本地 TypeScript 工具);
// MCP Server 接入(M3+)预留:清单里加 transport 字段描述外部 MCP Server 的启动方式,
// 届时在 makeTools 处用 MCPClient 拉起 stdio/sse 连接并把远端工具并入工具集
// ============================================================

export type AnyTool = ReturnType<typeof createTool>

/** 技能运行时类型 */
export type SkillRuntime = 'typescript' | 'python' | 'mcp'

/** 技能来源 */
export type SkillSource = 'builtin' | 'user'

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
  /** 协议 gating:对应 chain_protocols 表的 protocol_key(如 dex/lending/jupiter/meteora/orca/raydium/drift/starter-claim)。
   *  双轨过渡:表里有 disabled 行 → 技能隐藏;有 enabled 行 → 协议层视为可用(纯配置类不再回查老 cfg 字段);
   *  无行(未迁移) → 回落 chainFeature/cfg 字段老逻辑 */
  protocol?: string
  /** 协议行是可用性的必要条件(无行即隐藏):用于"从未有老配置字段可兜底"的主网专属协议(如 BENQI 质押)。
   *  dex/lending 这类有老 family 逻辑兜底的技能不要开,否则未 seed 的库会全链隐藏 */
  protocolRequired?: boolean
  /** 清单层禁用(如协议程序未部署到当前环境):不出现在清单/安装/工具集,工具 execute 仍兜底提示 */
  disabled?: boolean
  /** 技能运行时类型:typescript=同进程 TS 技能;python=MCP stdio Python 技能;mcp=外部 MCP server */
  runtime?: SkillRuntime
  /** 入口文件(相对技能目录),缺省 index.ts / index.py / server.ts */
  entry?: string
  /** 技能来源:builtin=系统内置;user=用户通过聊天生成 */
  source?: SkillSource
  /** 用户技能的所属 Agent(仅限 source='user');防止被其他 Agent 安装/调用 */
  ownerAgent?: { chainKey: string; tokenId: number }
  /** 用户技能的创建者钱包地址(审计用) */
  createdBy?: string
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

export function unregisterSkill(skillId: string): boolean {
  return builtins.delete(skillId)
}

export function clearSkills(): void {
  builtins.clear()
}

// ============================================================
// 协议可用性缓存(chain_protocols 表):isSkillAvailable 是同步函数且调用方多,
// 不改成异步查表;改为启动时 + 每次 admin 写操作后(reloadChainRegistry)由 index.ts
// 调 refreshProtocolCache(rows) 刷新,这里读缓存保持同步。
// ============================================================
const protocolCache = new Map<string, Map<string, boolean>>() // chainKey -> protocolKey -> enabled

/** 刷新协议可用性缓存(数据源 listChainProtocols()) */
export function refreshProtocolCache(rows: ChainProtocolRow[]): void {
  protocolCache.clear()
  for (const r of rows) {
    let m = protocolCache.get(r.chain_key)
    if (!m) {
      m = new Map()
      protocolCache.set(r.chain_key, m)
    }
    m.set(r.protocol_key, r.enabled)
  }
}

type ProtocolStatus = 'enabled' | 'disabled' | 'none'

/** 协议表对 (chainKey, protocol) 的意见:enabled / disabled / 无行 */
function protocolStatus(chainKey: string, protocol: string): ProtocolStatus {
  const enabled = protocolCache.get(chainKey)?.get(protocol)
  if (enabled === undefined) return 'none'
  return enabled ? 'enabled' : 'disabled'
}

/** 协议是否可用(对外 helper,供 gating 消费):协议表明确停用 → false;其余(含无行) → true。
 *  注意"无行"不代表协议已配置——未迁移链上技能可见性仍由 isSkillAvailable 的老逻辑兜底。 */
export function isProtocolAvailable(chainKey: string, protocol: string): boolean {
  return protocolStatus(chainKey, protocol) !== 'disabled'
}

/** 技能在指定链家族是否可用(evmOnly 技能在 Solana 下不可用;solanaOnly 技能要求 Solana 链;
 *  protocol 存在时先查协议表:disabled 行直接隐藏,enabled 行对纯配置类技能直接放行(协议表接管),
 *  无行或未接管的 chainFeature 类回落 chainFeature/cfg 字段老逻辑;disabled 技能全链隐藏) */
export function isSkillAvailable(chainKey: string, manifest: SkillManifest): boolean {
  if (manifest.disabled) return false
  const ctx = getChainContext(chainKey)
  if (manifest.evmOnly && ctx.family !== 'evm') return false
  if (manifest.solanaOnly && ctx.family !== 'solana') return false
  if (manifest.protocol) {
    const status = protocolStatus(chainKey, manifest.protocol)
    if (status === 'disabled') return false // 显式停用,优先于一切老配置
    if (status === 'enabled' && !manifest.chainFeature) return true // 协议表接管的纯配置类技能
    if (status === 'none' && manifest.protocolRequired) return false // 无协议行且无老逻辑可兜底 = 不可用(主网专属协议)
  }
  // 协议表无意见(none)或 chainFeature 类(后端就绪语义保留):老逻辑兜底
  if (manifest.solanaOnly) {
    if (manifest.chainFeature === 'jupiterApi' && !ctx.cfg.solana?.jupiterApiUrl) return false
    if (manifest.chainFeature === 'meteoraPool' && !isMeteoraPoolConfigured()) return false
  }
  return true
}

/** 全部可安装技能(清单);Solana 链下隐藏 evmOnly 技能;用户自定义技能不在这里列出(按 Agent 隔离) */
export function listSkills(chainKey: string): SkillManifest[] {
  return [...builtins.values()]
    .map((d) => d.manifest)
    .filter((m) => m.source !== 'user' && isSkillAvailable(chainKey, m))
}

/** 随 Agent 运行时默认启用的一组内置技能(新 Agent 首次装载时自动安装,无需主人手动装)。
 *  注意:defi-swap-meteora / defi-perp-drift 是 solanaOnly——ensureDefaultSkills 会按链家族
 *  自动跳过不可用项;二者都在主网执行(split-brain,见 chain/solanaExec.ts)。
 *  defi-perp-drift 暂不进默认集(2026-10 实测):dRiftyHA39... 主网部署已事实下线
 *  (自 2026-09-25 起拒绝所有用户交易,101 InstructionFallbackNotFound,任何公共 SDK
 *  都一样;Drift 已迁移至闭源 Velocity 程序)。自动装上会让用户对话时必踩链上错误;
 *  待接入 Velocity 或链侧恢复后再加入,届时可手动安装测试(读操作仍可用)。 */
export const DEFAULT_SKILL_IDS = ['social-greeter', 'defi-quote', 'defi-swap', 'defi-lending', 'defi-swap-meteora', 'owner-tuning', 'skill-creator']

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

/** 该 Agent 已安装的“用户自定义”技能(source='user') */
export async function getInstalledUserSkills(chainKey: string, tokenId: number): Promise<InstalledSkill[]> {
  const db = await getDb()
  const res = await db.query<InstalledSkill>(
    `SELECT s.id, s.name, s.version FROM agent_skills a
     JOIN skills s ON s.id = a.skill_id
     WHERE a.chain_key = $1 AND a.token_id = $2 AND s.manifest->>'source' = 'user'
     ORDER BY a.installed_at`,
    [chainKey, tokenId],
  )
  return res.rows
}

/** 已安装技能的 manifest 列表(含 description,供系统提示词生成能力摘要用;未匹配内置技能的跳过)。
 *  只返回当前链实际可用的:DB 里有安装记录但链配置不满足的技能(如缺 AGENT_SOLANA_PRIVATE_KEY 的
 *  defi-swap-meteora)不进能力摘要,避免提示词宣称"必须调用 propose_swap"而工具集里根本没有该工具 */
export async function getInstalledManifests(chainKey: string, tokenId: number): Promise<SkillManifest[]> {
  const installed = await getInstalledSkills(chainKey, tokenId)
  return installed
    .map((s) => builtins.get(s.id)?.manifest)
    .filter((m): m is SkillManifest => Boolean(m))
    .filter((m) => isSkillAvailable(chainKey, m))
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
  // 用户自定义技能只能安装到生成它的 Agent
  if (def.manifest.source === 'user') {
    const owner = def.manifest.ownerAgent
    if (!owner || owner.chainKey !== chainKey || owner.tokenId !== tokenId) {
      throw new SkillError(`用户自定义技能只能安装到生成它的 Agent`, 403)
    }
  }
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

/**
 * 删除用户自定义技能:校验它确实是 source='user' 且已安装,从 DB 卸载并从内存注册表移除。
 * 返回 false 表示该 Agent 未安装此技能;抛 SkillError 表示不是用户技能(禁止删除内置技能)。
 */
export async function deleteUserSkill(chainKey: string, tokenId: number, skillId: string): Promise<boolean> {
  const db = await getDb()
  const res = await db.query<{ source: string }>(
    `SELECT s.manifest->>'source' as source FROM agent_skills a
     JOIN skills s ON s.id = a.skill_id
     WHERE a.chain_key = $1 AND a.token_id = $2 AND a.skill_id = $3`,
    [chainKey, tokenId, skillId],
  )
  if (res.rows.length === 0) return false
  if (res.rows[0].source !== 'user') {
    throw new SkillError(`技能 ${skillId} 是系统内置技能,不能通过此接口删除`, 400)
  }
  await uninstallSkill(chainKey, tokenId, skillId)
  unregisterSkill(skillId)
  return true
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
    // 用户自定义技能严格按 Agent 隔离,防止被其他 Agent 的工具集加载
    if (def.manifest.source === 'user') {
      const owner = def.manifest.ownerAgent
      if (!owner || owner.chainKey !== chainKey || owner.tokenId !== tokenId) {
        console.warn(`[skills] ${chainKey}#${tokenId} 跳过非本 Agent 的用户技能 ${skill_id}`)
        continue
      }
    }
    if (!isSkillAvailable(chainKey, def.manifest)) {
      // 已安装但当前链配置不满足(如缺 AGENT_SOLANA_PRIVATE_KEY):工具不加载,打日志便于排查"装了技能却不生效"
      console.warn(`[skills] ${chainKey}#${tokenId} 已安装技能 ${skill_id} 因链配置不满足被跳过(工具不加载)`)
      continue
    }
    const scope = def.manifest.scope ?? 'all'
    if (scope !== 'all' && scope !== mode) continue
    Object.assign(tools, def.makeTools(chainKey, tokenId))
  }
  return tools
}
