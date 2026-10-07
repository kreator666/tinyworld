import {
  Connection,
  PublicKey,
  type AccountInfo,
  type GetProgramAccountsConfig,
  type RpcResponseAndContext,
  type TokenAccountsFilter,
} from '@solana/web3.js'
import { config } from '../config'
import { initSchema, listChainIdentities, upsertChainIdentities, type ChainIdentityRow } from '../db'
import { getChainContext } from './registry'
import { base58Decode, base58Encode } from '../core/base58'
import { readPersonaMirror } from '../core/personaMirror'
import idl from '../idl/tinyworld.json'
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
// Solana 链上人格装载(persona.ts 的 Solana 家族实现,公开接口与其完全一致)
// 程序:tinyworld(见 solana/README.md)
//   Identity PDA       = [b"identity", owner]
//   PartConfig PDA     = [b"part", u64le(part_id)]
//   AgentPermission PDA= [b"agent-permission", identity, agent](permissions u8, bit1=social)
// tokenId 语义(与 web 前端约定):identity.mint 公钥前 8 字节按 u64 小端解释。
// 账户解析不走 @coral-xyz/anchor,按 IDL 布局手工解码(只读场景,依赖更少)。
// ============================================================

// Token-2022 程序地址(装备/身份代币;余额解析按基础账户布局,扩展字段在 165 字节之后)
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

// 程序地址/连接按链分桶(多链重构):同一进程可能同时服务多条 Solana 链,
// 懒解析懒连接,key = chainKey
const programIds = new Map<string, PublicKey>()
function programId(chainKey: string): PublicKey {
  let pk = programIds.get(chainKey)
  if (!pk) {
    pk = new PublicKey(getChainContext(chainKey).cfg.identityAddress)
    programIds.set(chainKey, pk)
  }
  return pk
}

// 账户 discriminator 取自 IDL(= sha256("account:<Name>") 前 8 字节,anchor 约定)
type IdlAccount = { name: string; discriminator: number[] }
function accountDisc(name: string): Buffer {
  const acc = (idl.accounts as IdlAccount[]).find((a) => a.name === name)
  if (!acc) throw new Error(`IDL 中缺少账户定义: ${name}`)
  return Buffer.from(acc.discriminator)
}
const IDENTITY_DISC = accountDisc('Identity')
const PART_CONFIG_DISC = accountDisc('PartConfig')

// ------------------------------------------------------------
// RPC 故障转移:Solana 官方域名在某些网络环境间歇性不可达,
// 主端点出现网络类错误时按顺序轮换备用端点重试(只读调用,重试安全)。
// 只包装本模块用到的 4 个读方法,语义与 Connection 一致。
// ------------------------------------------------------------

function isNetworkError(e: unknown): boolean {
  const msg = String(e)
  return /fetch|timeout|ECONN|ETIMEDOUT|ENET|EAI_|socket|503|502|403|429/i.test(msg)
}

export class FailoverConnection {
  private conns: Connection[]
  private idx = 0

  constructor(endpoints: string[]) {
    this.conns = endpoints.map((u) => new Connection(u, 'confirmed'))
  }

  get endpoint(): string {
    return this.conns[this.idx].rpcEndpoint
  }

  private async withFailover<T>(op: (c: Connection) => Promise<T>): Promise<T> {
    let lastErr: unknown = null
    for (let attempt = 0; attempt < this.conns.length; attempt++) {
      const i = (this.idx + attempt) % this.conns.length
      try {
        const r = await op(this.conns[i])
        this.idx = i // 成功的端点提升为当前主端点
        return r
      } catch (e) {
        lastErr = e
        if (!isNetworkError(e)) throw e // 业务错误(RPC 可达)不重试
      }
    }
    throw lastErr
  }

  getProgramAccounts(
    programId: PublicKey,
    config?: GetProgramAccountsConfig,
  ): Promise<readonly { pubkey: PublicKey; account: AccountInfo<Buffer> }[]> {
    return this.withFailover((c) => c.getProgramAccounts(programId, config))
  }

  getAccountInfo(publicKey: PublicKey): Promise<AccountInfo<Buffer> | null> {
    return this.withFailover((c) => c.getAccountInfo(publicKey))
  }

  getTokenAccountsByOwner(
    owner: PublicKey,
    filter: TokenAccountsFilter,
  ): Promise<RpcResponseAndContext<readonly { pubkey: PublicKey; account: AccountInfo<Buffer> }[]>> {
    return this.withFailover((c) => c.getTokenAccountsByOwner(owner, filter))
  }

  getBalance(publicKey: PublicKey): Promise<number> {
    return this.withFailover((c) => c.getBalance(publicKey))
  }

  // 写路径(Jupiter 兑换发送交易):网络类错误重试是安全的——
  // 同一笔已签名交易按签名去重,重复提交不会产生第二笔扣款
  sendRawTransaction(raw: Uint8Array): Promise<string> {
    return this.withFailover((c) => c.sendRawTransaction(raw))
  }

  confirmTransaction(signature: string): Promise<void> {
    return this.withFailover((c) => c.confirmTransaction(signature, 'confirmed')).then(() => undefined)
  }
}

const connections = new Map<string, FailoverConnection>()
function connection(chainKey: string): FailoverConnection {
  let conn = connections.get(chainKey)
  if (!conn) {
    const { rpc, rpcFallbacks } = getChainContext(chainKey).cfg
    conn = new FailoverConnection([rpc, ...(rpcFallbacks ?? [])])
    connections.set(chainKey, conn)
  }
  return conn
}

/** 写路径(如 Jupiter 兑换)按 chainKey 取故障转移连接;读路径仍走上面的私有 connection */
export function solanaConnection(chainKey: string): FailoverConnection {
  return connection(chainKey)
}

// ------------------------------------------------------------
// 账户布局解码(borsh:字符串 = u32le 长度 + 字节,Option<T> = u8 tag(+ 载荷))
// ------------------------------------------------------------

interface IdentityAccount {
  owner: string
  mint: string
  name: string
  personaHash: string // 0x + 64hex;全 0 = 未设置
  personaArweaveId: string // 43 位 base64url txid 或空串
  equipped: (string | null)[] // 4 插槽:part mint(base58)或 null
  mintedAt: number // i64 秒
}

function decodeIdentity(data: Buffer): IdentityAccount {
  let o = 8 // 跳过 discriminator
  const readPubkey = (): string => {
    const v = new PublicKey(data.subarray(o, o + 32)).toBase58()
    o += 32
    return v
  }
  const readString = (): string => {
    const len = data.readUInt32LE(o)
    o += 4
    const s = data.subarray(o, o + len).toString('utf-8')
    o += len
    return s
  }
  const owner = readPubkey()
  const mint = readPubkey()
  const name = readString()
  o += 32 // name_hash(keccak256(小写 name)),读路径用不到
  const personaHash = '0x' + data.subarray(o, o + 32).toString('hex')
  o += 32
  const personaArweaveId = readString()
  const equipped: (string | null)[] = []
  for (let i = 0; i < 4; i++) {
    const tag = data[o++]
    if (tag === 1) {
      equipped.push(new PublicKey(data.subarray(o, o + 32)).toBase58())
      o += 32
    } else {
      equipped.push(null) // tag 0 = None
    }
  }
  // agent_count(u32) recipe_id(u64) mint_fee(u64)
  o += 4 + 8 + 8
  const mintedAt = Number(data.readBigInt64LE(o))
  return { owner, mint, name, personaHash, personaArweaveId, equipped, mintedAt }
}

interface PartConfigAccount {
  partId: number
  mint: string
}

function decodePartConfig(data: Buffer): PartConfigAccount {
  return {
    partId: Number(data.readBigUInt64LE(8)),
    mint: new PublicKey(data.subarray(16, 48)).toBase58(),
  }
}

/** tokenId 语义:mint 公钥字节前 8 字节按 u64 小端解释(与 web 前端约定一致) */
export function tokenIdFromMint(mint: string): number {
  const bytes = base58Decode(mint)
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i])
  return Number(v)
}

// ------------------------------------------------------------
// GPA 扫描。Identity/PartConfig 没有链上枚举接口,用 getProgramAccounts +
// discriminator memcmp 过滤(注明:未来换索引器/The Graph 类服务)
// 结果带 15s TTL 缓存,避免一次对话回合内反复全表扫。
// ------------------------------------------------------------

interface IdentityEntry {
  pubkey: PublicKey // Identity PDA
  account: IdentityAccount
}

// ------------------------------------------------------------
// 链上身份镜像(DB):GPA 是索引类方法,官方 RPC 不可达时常用备用节点不支持,
// 且测试网会定期重置。扫描/解析成功后把身份快照落库(chain_identities 表),
// GPA 失败时以镜像兜底(可能滞后),同时为测试网重置后的重建提供种子。
// 镜像写失败只告警,不影响链上读取。
// ------------------------------------------------------------

function mirrorRowsFromEntries(chainKey: string, entries: IdentityEntry[]): ChainIdentityRow[] {
  return entries.map((e) => ({
    token_id: String(tokenIdFromMint(e.account.mint)),
    owner: e.account.owner,
    name: e.account.name,
    mint: e.account.mint,
    persona_hash: e.account.personaHash,
    persona_arweave_id: e.account.personaArweaveId,
    minted_at: e.account.mintedAt,
    chain_key: chainKey,
  }))
}

let mirrorSchemaReady = false

async function mirrorIdentities(chainKey: string, entries: IdentityEntry[]): Promise<void> {
  try {
    // 冒烟/脚本场景不会走服务启动的 initSchema,这里兜底一次(幂等)
    if (!mirrorSchemaReady) {
      await initSchema()
      mirrorSchemaReady = true
    }
    await upsertChainIdentities(mirrorRowsFromEntries(chainKey, entries))
  } catch (e) {
    console.warn('[persona-solana] 身份镜像写入失败(不影响读取):', e)
  }
}

/** 镜像行 → IdentityEntry;equipped 链上未读,降级场景按空槽处理(装备读取需链上可用) */
async function entriesFromMirror(chainKey: string): Promise<IdentityEntry[]> {
  if (!mirrorSchemaReady) {
    await initSchema()
    mirrorSchemaReady = true
  }
  const rows = await listChainIdentities(chainKey)
  return rows.map((r) => ({
    pubkey: PublicKey.findProgramAddressSync(
      [Buffer.from('identity'), new PublicKey(r.owner).toBuffer()],
      programId(chainKey),
    )[0],
    account: {
      owner: r.owner,
      mint: r.mint,
      name: r.name,
      personaHash: r.persona_hash,
      personaArweaveId: r.persona_arweave_id,
      equipped: [null, null, null, null],
      mintedAt: Number(r.minted_at),
    },
  }))
}

// GPA 扫描缓存按链分桶(多链重构)
const identityScanCaches = new Map<string, { at: number; entries: IdentityEntry[] }>()
const SCAN_TTL_MS = 15_000

async function fetchAllIdentities(chainKey: string, force = false): Promise<IdentityEntry[]> {
  const cached = identityScanCaches.get(chainKey)
  if (!force && cached && Date.now() - cached.at < SCAN_TTL_MS) {
    return cached.entries
  }
  try {
    const res = await connection(chainKey).getProgramAccounts(programId(chainKey), {
      filters: [{ memcmp: { offset: 0, bytes: base58Encode(IDENTITY_DISC) } }],
    })
    const entries = res.map((r) => ({ pubkey: r.pubkey, account: decodeIdentity(r.account.data) }))
    identityScanCaches.set(chainKey, { at: Date.now(), entries })
    await mirrorIdentities(chainKey, entries)
    return entries
  } catch (e) {
    // GPA 失败(官方 RPC 不可达 + 备用节点不支持索引类方法):回退 DB 镜像
    const mirrored = await entriesFromMirror(chainKey)
    if (mirrored.length > 0) {
      console.warn(`[persona-solana] ${chainKey} GPA 失败(${String(e).slice(0, 80)}),回退 DB 镜像(${mirrored.length} 条,可能滞后)`)
      identityScanCaches.set(chainKey, { at: Date.now(), entries: mirrored })
      return mirrored
    }
    throw e
  }
}

async function findIdentityByTokenId(chainKey: string, tokenId: number): Promise<IdentityEntry | null> {
  const entries = await fetchAllIdentities(chainKey)
  const hit = entries.find((e) => tokenIdFromMint(e.account.mint) === tokenId)
  if (hit) return hit
  // TTL 缓存可能刚被新铸造的 Identity 绕过:未命中时强制重扫一次再下结论
  const fresh = await fetchAllIdentities(chainKey, true)
  return fresh.find((e) => tokenIdFromMint(e.account.mint) === tokenId) ?? null
}

const partScanCaches = new Map<string, { at: number; parts: PartConfigAccount[] }>()

async function fetchAllPartConfigs(chainKey: string, force = false): Promise<PartConfigAccount[]> {
  const cached = partScanCaches.get(chainKey)
  if (!force && cached && Date.now() - cached.at < SCAN_TTL_MS) {
    return cached.parts
  }
  const res = await connection(chainKey).getProgramAccounts(programId(chainKey), {
    filters: [{ memcmp: { offset: 0, bytes: base58Encode(PART_CONFIG_DISC) } }],
  })
  const parts = res.map((r) => decodePartConfig(r.account.data))
  partScanCaches.set(chainKey, { at: Date.now(), parts })
  return parts
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
// 公开接口(与 persona.ts 完全一致的签名与语义;多链重构:首参 chainKey)
// ------------------------------------------------------------

export { PERMISSION_SOCIAL, PersonaError, defaultAIProfile, personaCache, personaCacheKey }
export type { AgentSummary, EquipmentItem, LoadedPersona, WalletAssets }

/** base58 地址校验(32~44 位 base58 且能解析为 32 字节公钥;链无关) */
export function isValidSolanaAddress(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false
  try {
    new PublicKey(address)
    return true
  } catch {
    return false
  }
}

/** 地址 → tokenId;未铸造(无 Identity PDA)返回 0(与 EVM 合约约定一致) */
export async function resolveTokenId(chainKey: string, owner: string): Promise<number> {
  const ownerPk = new PublicKey(owner) // 非法地址直接抛
  const [identityPda] = PublicKey.findProgramAddressSync([Buffer.from('identity'), ownerPk.toBuffer()], programId(chainKey))
  const info = await connection(chainKey).getAccountInfo(identityPda)
  if (!info) return 0
  const account = decodeIdentity(info.data)
  await mirrorIdentities(chainKey, [{ pubkey: identityPda, account }]) // 增量镜像:新铸造无需等全表扫
  return tokenIdFromMint(account.mint)
}

/** tokenId → owner 地址(GPA 扫 Identity 匹配 mint 前 8 字节;未来换索引器) */
export async function ownerOf(chainKey: string, tokenId: number): Promise<string> {
  const hit = await findIdentityByTokenId(chainKey, tokenId)
  if (!hit) throw new Error(`[${chainKey}] 链上不存在 tokenId=${tokenId} 的 Agent`)
  return hit.account.owner
}

/** 链上 agentPermissions[tokenId][agent] 位掩码(无 AgentPermission PDA 返回 0n) */
export async function getAgentPermissions(chainKey: string, tokenId: number, agentAddr: string): Promise<bigint> {
  const hit = await findIdentityByTokenId(chainKey, tokenId)
  if (!hit) return 0n
  const agentPk = new PublicKey(agentAddr)
  const [permPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('agent-permission'), hit.pubkey.toBuffer(), agentPk.toBuffer()],
    programId(chainKey),
  )
  const info = await connection(chainKey).getAccountInfo(permPda)
  if (!info) return 0n
  // 布局:disc(8) identity(32) agent(32) permissions(u8) bump(u8)
  return BigInt(info.data[72])
}

/**
 * 从链上读取并校验人格。
 * 过渡镜像:链上 persona_hash → 本地镜像(agent/data/personas/<hash>.json,经 /personas/:hash 写入)
 * 取回 JSON 并 keccak256 校验(不一致抛 PersonaError,与 EVM 侧一致);
 * 镜像缺失时以 persona_arweave_id(ar:// 或 43 位 txid)从 https://arweave.net/<txid> 兜底;
 * 两者都拿不到:hash 全 0 → 默认人格兜底,否则抛 PersonaError(人格数据丢失)。
 */
export async function fetchPersonaFromChain(chainKey: string, tokenId: number): Promise<LoadedPersona> {
  const hit = await findIdentityByTokenId(chainKey, tokenId)
  if (!hit) throw new Error(`[${chainKey}] 链上不存在 tokenId=${tokenId} 的 Agent`)
  const { name, owner, personaHash, personaArweaveId } = hit.account

  if (isZeroHash(personaHash)) {
    return { tokenId, name, owner, profile: defaultAIProfile, fromChain: false, contentHash: personaHash }
  }

  let json: string | null = await readPersonaMirror(personaHash) // 同进程直接函数调用
  if (json !== null) {
    json = stripDataPrefix(json) // web 可能重组 data URI 存镜像,解析逻辑与 EVM 侧相同
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

/** 人格缓存:每个 (链, tokenId) 只装载一次,reload 接口强制刷新(与 EVM 侧共用语义) */
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
  const entries = await fetchAllIdentities(chainKey)
  return entries
    .sort((a, b) => a.account.mintedAt - b.account.mintedAt)
    .map((e) => ({ tokenId: tokenIdFromMint(e.account.mint), name: e.account.name, owner: e.account.owner, bio: '' }))
}

/** 列出最新铸造的 N 个 Agent(social-greeter 的 list_new_agents 用),按铸造时间倒序 */
export async function listRecentAgents(chainKey: string, limit = 5): Promise<AgentSummary[]> {
  const all = await listMintedAgents(chainKey)
  return all.slice(-limit).reverse()
}

/** 读链上装备(Identity.equipped)并概述主人持有量(Token-2022 账户余额) */
export async function getEquipment(chainKey: string, tokenId: number): Promise<EquipmentItem[]> {
  const hit = await findIdentityByTokenId(chainKey, tokenId)
  if (!hit) throw new Error(`[${chainKey}] 链上不存在 tokenId=${tokenId} 的 Agent`)
  const parts = await fetchAllPartConfigs(chainKey)
  const result: EquipmentItem[] = []
  for (let slot = 0; slot < hit.account.equipped.length; slot++) {
    const partMint = hit.account.equipped[slot]
    if (!partMint) continue // 空槽位
    const part = parts.find((p) => p.mint === partMint)
    // PartConfig 没有 name 字段,装备名前端按 part_id 对本地静态目录,对不上显示 Part #<id>;
    // 找不到 PartConfig(异常数据)时 partId 记 0
    const partId = part ? part.partId : 0
    const balance = await ownerPartBalance(chainKey, hit.account.owner, partMint)
    result.push({ slot, collection: partMint, partId, balance })
  }
  return result
}

/** 主人在某 part mint 的持有量(按 mint 过滤,Token-2022 与经典 SPL 账户都命中;装备在 escrow 时不计入) */
async function ownerPartBalance(chainKey: string, owner: string, mint: string): Promise<number> {
  // 注意:getTokenAccountsByOwner 的 filter 只能是 mint 或 programId 二选一,
  // 同时传两个会报 "Token mint could not be unpacked";按 mint 过滤天然跨两种代币程序
  const accounts = await connection(chainKey).getTokenAccountsByOwner(new PublicKey(owner), {
    mint: new PublicKey(mint),
  })
  let total = 0
  for (const { account } of accounts.value) {
    // 代币账户基础布局一致:amount 在偏移 64(u64le);Token-2022 扩展字段在其后
    total += Number(account.data.readBigUInt64LE(64))
  }
  return total
}

/** 主人在指定 mint 的代币余额:按 mint 过滤(跨 Token-2022/经典 SPL),按基础布局偏移 64(u64le)求和,6 位小数 */
async function stablecoinBalance(chainKey: string, owner: string, mint: string): Promise<number> {
  if (!mint) return 0
  try {
    const accounts = await connection(chainKey).getTokenAccountsByOwner(new PublicKey(owner), {
      mint: new PublicKey(mint),
    })
    let total = 0n
    for (const { account } of accounts.value) {
      total += account.data.readBigUInt64LE(64)
    }
    return Number(total) / 1e6
  } catch (e) {
    // mint 在该链不存在/不是合法 mint 时 RPC 会拒绝过滤条件,按余额 0 处理(不影响 SOL 与装备)
    console.warn(`[persona-solana] ${chainKey} 稳定币余额查询失败(mint ${mint}):`, String(e).slice(0, 100))
    return 0
  }
}

/** 钱包资产:SOL 原生余额 + USDC/USDT(Token-2022/经典 SPL 账户)+ DID 装备 */
export async function getWalletAssets(chainKey: string, address: string, tokenId: number): Promise<WalletAssets> {
  const lamports = await connection(chainKey).getBalance(new PublicKey(address))
  const equipment = await getEquipment(chainKey, tokenId)
  const { usdcMint, usdtMint } = getChainContext(chainKey).cfg.solana ?? {}
  const [usdc, usdt] = await Promise.all([
    stablecoinBalance(chainKey, address, usdcMint ?? ''),
    stablecoinBalance(chainKey, address, usdtMint ?? ''),
  ])
  return {
    address,
    nativeBalance: (lamports / 1e9).toString(),
    nativeSymbol: 'SOL',
    usdcBalance: usdc.toString(),
    usdtBalance: usdt.toString(),
    equipment,
  }
}
