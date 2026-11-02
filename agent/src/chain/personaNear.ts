import { initSchema, listChainIdentities, upsertChainIdentities, type ChainIdentityRow } from '../db'
import { getChainContext } from './registry'
import { readPersonaMirror } from '../core/personaMirror'
import {
  PERMISSION_SOCIAL,
  PersonaError,
  defaultAIProfile,
  personaCache,
  personaCacheKey,
  parseVerifiedPersona,
  stripDataPrefix,
  type AgentSummary,
  type EquipmentItem,
  type LoadedPersona,
  type WalletAssets,
} from './personaShared'

// ============================================================
// NEAR 链上人格装载(persona.ts 的 NEAR 家族实现,公开接口与 personaSolana 完全对齐)
// 合约:tinyworld(Rust/near-sdk 5.30,NEP-171 风格 Soulbound 身份 + 装备部件,见 near/README.md)
// view 方法用裸 fetch 打 NEAR JSON-RPC query(request_type=call_function),
// 不引入 near-api-js 依赖;result.result 是 u8 数组,String.fromCharCode 拼接后 JSON.parse。
// tokenId 语义(与 EVM 对齐):NEAR token_id 是字符串整数,解析为 number。
// persona_hash 链上为 64 位 hex 无前缀,本模块统一规范化成 0x 前缀(与 EVM/Solana 侧一致)。
// 本阶段后端只读:不发交易,写路径(装备/铸造/转账)留 TODO。
// ============================================================

// ------------------------------------------------------------
// JSON-RPC 故障转移:主端点出现网络类错误时按顺序轮换备用端点重试
// (只读 view 调用,重试安全)。写路径(未来 NEAR 交易签名)加入时同样复用此类。
// ------------------------------------------------------------

function isNetworkError(e: unknown): boolean {
  const msg = String(e)
  return /fetch|timeout|ECONN|ETIMEDOUT|ENET|EAI_|socket|503|502|403|429/i.test(msg)
}

// NEAR JSON-RPC 响应骨架(call_function / view_account 共用信封)
interface NearJsonRpcResponse {
  result?: { result?: number[]; error?: string } & Record<string, unknown>
  error?: { code?: number; message?: string; data?: unknown }
}

export class NearFailoverRpc {
  private endpoints: string[]
  private idx = 0

  constructor(endpoints: string[]) {
    this.endpoints = endpoints.filter(Boolean)
    if (this.endpoints.length === 0) throw new Error('NEAR RPC 端点为空')
  }

  get endpoint(): string {
    return this.endpoints[this.idx]
  }

  private async withFailover<T>(op: (endpoint: string) => Promise<T>): Promise<T> {
    let lastErr: unknown = null
    for (let attempt = 0; attempt < this.endpoints.length; attempt++) {
      const i = (this.idx + attempt) % this.endpoints.length
      try {
        const r = await op(this.endpoints[i])
        this.idx = i // 成功的端点提升为当前主端点
        return r
      } catch (e) {
        lastErr = e
        if (!isNetworkError(e)) throw e // 业务错误(RPC 可达)不重试
      }
    }
    throw lastErr
  }

  private async post(endpoint: string, body: Record<string, unknown>): Promise<NearJsonRpcResponse> {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`NEAR RPC HTTP ${res.status}(${endpoint})`)
    return (await res.json()) as NearJsonRpcResponse
  }

  /**
   * 调合约 view 方法(JSON-RPC query / call_function)。
   * 返回 null 表示合约侧返回 JSON null(Option::None);合约 panic / 账户不存在抛错。
   */
  async viewFunction<T>(accountId: string, methodName: string, args: Record<string, unknown>): Promise<T> {
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: accountId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args), 'utf-8').toString('base64'),
      },
    }
    const res = await this.withFailover((endpoint) => this.post(endpoint, payload))
    if (res.error) {
      const detail = res.error.data !== undefined ? ` ${JSON.stringify(res.error.data)}` : ''
      throw new Error(`NEAR view ${methodName} 失败: ${res.error.message ?? JSON.stringify(res.error)}${detail}`)
    }
    const bytes = res.result?.result
    if (!Array.isArray(bytes)) throw new Error(`NEAR view ${methodName} 返回缺少 result.result`)
    const text = String.fromCharCode(...bytes)
    return text.length === 0 ? (null as T) : (JSON.parse(text) as T)
  }

  /** 账户原生余额(view_account.amount 为 yoctoNEAR 字符串) */
  async viewAccountAmount(accountId: string): Promise<string> {
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: accountId },
    }
    const res = await this.withFailover((endpoint) => this.post(endpoint, payload))
    if (res.error) {
      const detail = res.error.data !== undefined ? ` ${JSON.stringify(res.error.data)}` : ''
      throw new Error(`NEAR view_account 失败: ${res.error.message ?? JSON.stringify(res.error)}${detail}`)
    }
    return (res.result as { amount: string }).amount
  }
}

const rpcClients = new Map<string, NearFailoverRpc>()
function rpc(chainKey: string): NearFailoverRpc {
  let client = rpcClients.get(chainKey)
  if (!client) {
    const { rpc: primary, rpcFallbacks } = getChainContext(chainKey).cfg
    client = new NearFailoverRpc([primary, ...(rpcFallbacks ?? [])])
    rpcClients.set(chainKey, client)
  }
  return client
}

// ------------------------------------------------------------
// 合约 view 返回的原始形状(未经规范化)
// U64/U128 在 near-sdk 中序列化为 JSON 字符串;Option<U64> 为 null 或字符串
// ------------------------------------------------------------

interface NearIdentityViewRaw {
  token_id: string
  owner_id: string
  name: string
  persona_hash: string // 64 位 hex 无前缀;全 0 = 未设置
  persona_arweave_id: string
  equipped: (string | null)[] // 4 插槽:part_id(字符串整数)或 null
  unlocked: boolean
  agents: { account_id: string; permissions: number }[]
  minted_at: string // U64 秒
}

/** 规范化后的内部身份类型(跨链读路径统一用) */
interface NearIdentity {
  tokenId: number
  owner: string
  name: string
  personaHash: string // 0x + 64hex(小写);全 0 = 未设置
  personaArweaveId: string
  equipped: (number | null)[] // 4 插槽 part_id 或 null
  mintedAt: number
}

/** persona_hash 规范化:NEAR 无前缀 hex → 0x 前缀小写(与 EVM/Solana 侧一致) */
function normalizePersonaHash(raw: string): string {
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw
  return '0x' + hex.toLowerCase()
}

function normalizeIdentity(raw: NearIdentityViewRaw): NearIdentity {
  return {
    tokenId: Number(raw.token_id),
    owner: raw.owner_id,
    name: raw.name,
    personaHash: normalizePersonaHash(raw.persona_hash),
    personaArweaveId: raw.persona_arweave_id,
    equipped: raw.equipped.map((p) => (p === null ? null : Number(p))),
    mintedAt: Number(raw.minted_at),
  }
}

function isZeroHash(hash: string): boolean {
  return /^0x0{64}$/i.test(hash)
}

/** 规范化 arweave id:支持 ar://<txid> 与裸 43 位 txid;空串/非法返回 null */
function normalizeArweaveId(raw: string): string | null {
  const txid = raw.startsWith('ar://') ? raw.slice('ar://'.length) : raw
  return /^[A-Za-z0-9_-]{43}$/.test(txid) ? txid : null
}

// ------------------------------------------------------------
// 身份读取(15s TTL 缓存,按链分桶)。NEAR view 方法支持按 owner/token_id 直接查询,
// 无需 Solana 那种 GPA 全表扫;缓存只为避免一次对话回合内反复打 RPC。
// ------------------------------------------------------------

const SCAN_TTL_MS = 15_000

const byTokenIdCaches = new Map<string, Map<number, { at: number; identity: NearIdentity | null }>>()
const byOwnerCaches = new Map<string, Map<string, { at: number; identity: NearIdentity | null }>>()
const allIdentitiesCaches = new Map<string, { at: number; identities: NearIdentity[] }>()

function contractId(chainKey: string): string {
  return getChainContext(chainKey).cfg.identityAddress
}

async function fetchIdentityByTokenId(chainKey: string, tokenId: number, force = false): Promise<NearIdentity | null> {
  let cache = byTokenIdCaches.get(chainKey)
  if (!cache) {
    cache = new Map()
    byTokenIdCaches.set(chainKey, cache)
  }
  if (!force) {
    const hit = cache.get(tokenId)
    if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.identity
  }
  const raw = await rpc(chainKey).viewFunction<NearIdentityViewRaw | null>(contractId(chainKey), 'get_identity', {
    token_id: String(tokenId),
  })
  const identity = raw === null ? null : normalizeIdentity(raw)
  cache.set(tokenId, { at: Date.now(), identity })
  return identity
}

async function fetchIdentityByOwner(chainKey: string, owner: string, force = false): Promise<NearIdentity | null> {
  let cache = byOwnerCaches.get(chainKey)
  if (!cache) {
    cache = new Map()
    byOwnerCaches.set(chainKey, cache)
  }
  if (!force) {
    const hit = cache.get(owner)
    if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.identity
  }
  const raw = await rpc(chainKey).viewFunction<NearIdentityViewRaw | null>(contractId(chainKey), 'get_identity_by_owner', {
    account_id: owner,
  })
  const identity = raw === null ? null : normalizeIdentity(raw)
  cache.set(owner, { at: Date.now(), identity })
  // 增量镜像:新铸造无需等全量枚举(与 personaSolana 的 resolveTokenId 语义对齐)
  if (identity) await mirrorIdentities(chainKey, [identity])
  return identity
}

/** 全部已铸造身份:get_mint_count + 逐个 get_identity(token_id 自增 1..count) */
async function fetchAllIdentities(chainKey: string, force = false): Promise<NearIdentity[]> {
  const cached = allIdentitiesCaches.get(chainKey)
  if (!force && cached && Date.now() - cached.at < SCAN_TTL_MS) {
    return cached.identities
  }
  try {
    const count = Number(
      await rpc(chainKey).viewFunction<string>(contractId(chainKey), 'get_mint_count', {}),
    )
    const raws = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        rpc(chainKey).viewFunction<NearIdentityViewRaw | null>(contractId(chainKey), 'get_identity', {
          token_id: String(i + 1),
        }),
      ),
    )
    const identities = raws.filter((r): r is NearIdentityViewRaw => r !== null).map(normalizeIdentity)
    allIdentitiesCaches.set(chainKey, { at: Date.now(), identities })
    await mirrorIdentities(chainKey, identities)
    return identities
  } catch (e) {
    // 枚举失败(RPC 不可达):回退 DB 镜像(可能滞后);与 personaSolana 的 GPA 回退语义对齐
    const mirrored = await identitiesFromMirror(chainKey)
    if (mirrored.length > 0) {
      console.warn(`[persona-near] ${chainKey} 身份枚举失败(${String(e).slice(0, 80)}),回退 DB 镜像(${mirrored.length} 条,可能滞后)`)
      allIdentitiesCaches.set(chainKey, { at: Date.now(), identities: mirrored })
      return mirrored
    }
    throw e
  }
}

// ------------------------------------------------------------
// 链上身份镜像(DB chain_identities 表):与 personaSolana 对齐——
// 读取成功后落镜像支撑 /identities/of 跨链映射;失败只告警,不影响链上读取。
// NEAR 无 mint 概念(token_id 即身份标识),mint 列留空。
// ------------------------------------------------------------

function mirrorRowsFromIdentities(chainKey: string, identities: NearIdentity[]): ChainIdentityRow[] {
  return identities.map((i) => ({
    token_id: String(i.tokenId),
    owner: i.owner,
    name: i.name,
    mint: '',
    persona_hash: i.personaHash,
    persona_arweave_id: i.personaArweaveId,
    minted_at: i.mintedAt,
    chain_key: chainKey,
  }))
}

let mirrorSchemaReady = false

async function mirrorIdentities(chainKey: string, identities: NearIdentity[]): Promise<void> {
  try {
    // 冒烟/脚本场景不会走服务启动的 initSchema,这里兜底一次(幂等)
    if (!mirrorSchemaReady) {
      await initSchema()
      mirrorSchemaReady = true
    }
    await upsertChainIdentities(mirrorRowsFromIdentities(chainKey, identities))
  } catch (e) {
    console.warn('[persona-near] 身份镜像写入失败(不影响读取):', e)
  }
}

/** 镜像行 → NearIdentity;equipped 链上未读,降级场景按空槽处理(装备读取需链上可用) */
async function identitiesFromMirror(chainKey: string): Promise<NearIdentity[]> {
  if (!mirrorSchemaReady) {
    await initSchema()
    mirrorSchemaReady = true
  }
  const rows = await listChainIdentities(chainKey)
  return rows.map((r) => ({
    tokenId: Number(r.token_id),
    owner: r.owner,
    name: r.name,
    personaHash: normalizePersonaHash(r.persona_hash),
    personaArweaveId: r.persona_arweave_id,
    equipped: [null, null, null, null],
    mintedAt: Number(r.minted_at),
  }))
}

// ------------------------------------------------------------
// 公开接口(与 persona.ts / personaSolana.ts 完全一致的签名与语义;首参 chainKey)
// ------------------------------------------------------------

export { PERMISSION_SOCIAL, PersonaError, defaultAIProfile, personaCache, personaCacheKey }
export type { AgentSummary, EquipmentItem, LoadedPersona, WalletAssets }

/** NEAR account_id 校验:2~64 位小写字母数字,分隔符 - _ . 不连续且不在首尾(NEAR 命名规则) */
export function isValidNearAddress(address: string): boolean {
  return /^[a-z0-9](?:[a-z0-9]|[-_.](?=[a-z0-9])){1,63}$/.test(address)
}

/** 地址(account_id)→ tokenId;未铸造返回 0(与 EVM/Solana 合约约定一致) */
export async function resolveTokenId(chainKey: string, owner: string): Promise<number> {
  const identity = await fetchIdentityByOwner(chainKey, owner)
  return identity ? identity.tokenId : 0
}

/** tokenId → owner 地址 */
export async function ownerOf(chainKey: string, tokenId: number): Promise<string> {
  const identity = await fetchIdentityByTokenId(chainKey, tokenId)
  if (!identity) throw new Error(`[${chainKey}] 链上不存在 tokenId=${tokenId} 的 Agent`)
  return identity.owner
}

/** 链上 agentPermissions[tokenId][agent] 位掩码(未授权返回 0n) */
export async function getAgentPermissions(chainKey: string, tokenId: number, agentAddr: string): Promise<bigint> {
  const perms = await rpc(chainKey).viewFunction<number>(
    contractId(chainKey),
    'get_agent_permissions',
    { token_id: String(tokenId), agent: agentAddr },
  )
  return BigInt(perms ?? 0)
}

/**
 * 从链上读取并校验人格。
 * 过渡镜像:链上 persona_hash → 本地镜像(agent/data/personas/<hash>.json,经 /personas/:hash 写入)
 * 取回 JSON 并 keccak256 校验(不一致抛 PersonaError,与 EVM/Solana 侧一致);
 * 镜像缺失时以 persona_arweave_id(ar:// 或 43 位 txid)从 https://arweave.net/<txid> 兜底;
 * 两者都拿不到:hash 全 0 → 默认人格兜底,否则抛 PersonaError(人格数据丢失)。
 */
export async function fetchPersonaFromChain(chainKey: string, tokenId: number): Promise<LoadedPersona> {
  const identity = await fetchIdentityByTokenId(chainKey, tokenId)
  if (!identity) throw new Error(`[${chainKey}] 链上不存在 tokenId=${tokenId} 的 Agent`)
  const { name, owner, personaHash, personaArweaveId } = identity

  if (isZeroHash(personaHash)) {
    return { tokenId, name, owner, profile: defaultAIProfile, fromChain: false, contentHash: personaHash }
  }

  let json: string | null = await readPersonaMirror(personaHash) // 同进程直接函数调用
  if (json !== null) {
    json = stripDataPrefix(json) // web 可能重组 data URI 存镜像,解析逻辑与 EVM/Solana 侧相同
  } else {
    const txid = normalizeArweaveId(personaArweaveId)
    if (txid) {
      try {
        const res = await fetch(`https://arweave.net/${txid}`)
        if (res.ok) json = stripDataPrefix(await res.text())
      } catch {
        // Arweave 不可达:按人格数据丢失处理
      }
    }
  }
  if (json === null) {
    throw new PersonaError('人格数据丢失:本地镜像不存在且 Arweave 兜底不可用(链上 persona_hash 非全 0),拒绝装载')
  }
  const profile = parseVerifiedPersona(json, personaHash)
  return { tokenId, name, owner, profile, fromChain: true, contentHash: personaHash }
}

/** 人格缓存:每个 (链, tokenId) 只装载一次,reload 接口强制刷新(三家族共用语义) */
export async function loadPersona(chainKey: string, tokenId: number, force = false): Promise<LoadedPersona> {
  const cacheKey = personaCacheKey(chainKey, tokenId)
  if (!force) {
    const cached = personaCache.get(cacheKey)
    if (cached) return cached
  }
  const persona = await fetchPersonaFromChain(chainKey, tokenId)
  personaCache.set(cacheKey, persona)
  return persona
}

export function getCachedPersona(chainKey: string, tokenId: number): LoadedPersona | undefined {
  return personaCache.get(personaCacheKey(chainKey, tokenId))
}

/** 列出全部已铸造的 Agent(心跳调度器每轮枚举用),按铸造时间(≈tokenId)升序 */
export async function listMintedAgents(chainKey: string): Promise<AgentSummary[]> {
  const identities = await fetchAllIdentities(chainKey)
  return identities
    .sort((a, b) => a.mintedAt - b.mintedAt)
    .map((i) => ({ tokenId: i.tokenId, name: i.name, owner: i.owner, bio: '' }))
}

/** 列出最新铸造的 N 个 Agent(social-greeter 的 list_new_agents 用),按铸造时间倒序 */
export async function listRecentAgents(chainKey: string, limit = 5): Promise<AgentSummary[]> {
  const all = await listMintedAgents(chainKey)
  return all.slice(-limit).reverse()
}

/** 读链上装备(get_equipped)并概述主人持有量(part_balance_of) */
export async function getEquipment(chainKey: string, tokenId: number): Promise<EquipmentItem[]> {
  const identity = await fetchIdentityByTokenId(chainKey, tokenId)
  if (!identity) throw new Error(`[${chainKey}] 链上不存在 tokenId=${tokenId} 的 Agent`)
  const parts = await rpc(chainKey).viewFunction<(string | null)[]>(contractId(chainKey), 'get_equipped', {
    token_id: String(tokenId),
  })
  // NEAR 部件没有独立集合地址,单合约托管:collection 记合约 account_id(占位形状对齐)
  const collection = getChainContext(chainKey).cfg.partsAddress
  const result: EquipmentItem[] = []
  for (let slot = 0; slot < parts.length; slot++) {
    const partIdStr = parts[slot]
    if (partIdStr === null) continue // 空槽位
    const partId = Number(partIdStr)
    const balance = await rpc(chainKey).viewFunction<string>(contractId(chainKey), 'part_balance_of', {
      account_id: identity.owner,
      part_id: partIdStr,
    })
    result.push({ slot, collection, partId, balance: Number(balance ?? 0) })
  }
  return result
}

/** 钱包资产:NEAR 原生余额(yoctoNEAR → NEAR)+ DID 装备;稳定币未配置(NEAR 链无 usdc/usdt mint 配置),恒 0 */
export async function getWalletAssets(chainKey: string, address: string, tokenId: number): Promise<WalletAssets> {
  const amountYocto = await rpc(chainKey).viewAccountAmount(address)
  const equipment = await getEquipment(chainKey, tokenId)
  return {
    address,
    nativeBalance: (BigInt(amountYocto) / 10n ** 24n).toString(),
    nativeSymbol: 'NEAR',
    usdcBalance: '0',
    usdtBalance: '0',
    equipment,
  }
}
