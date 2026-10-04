import { Connection, PublicKey } from '@solana/web3.js'
import { config } from '../config'
import { base58Decode, base58Encode } from '../core/base58'
import { readPersonaMirror } from '../core/personaMirror'
import idl from '../idl/tinyworld.json'
import {
  PERMISSION_SOCIAL,
  PersonaError,
  defaultAIProfile,
  personaCache,
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

// 程序地址 lazy 解析:persona.ts 在 EVM 链下也会 import 本模块,
// 模块级 new PublicKey(0x 地址)会把整个进程打崩,必须在首次 Solana 调用时才解析
let programIdSingleton: PublicKey | null = null
function programId(): PublicKey {
  if (!programIdSingleton) programIdSingleton = new PublicKey(config.chain.identityAddress)
  return programIdSingleton
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

let connectionSingleton: Connection | null = null
function connection(): Connection {
  if (!connectionSingleton) connectionSingleton = new Connection(config.chain.rpc, 'confirmed')
  return connectionSingleton
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

let identityScanCache: { at: number; entries: IdentityEntry[] } | null = null
const SCAN_TTL_MS = 15_000

async function fetchAllIdentities(force = false): Promise<IdentityEntry[]> {
  if (!force && identityScanCache && Date.now() - identityScanCache.at < SCAN_TTL_MS) {
    return identityScanCache.entries
  }
  const res = await connection().getProgramAccounts(programId(), {
    filters: [{ memcmp: { offset: 0, bytes: base58Encode(IDENTITY_DISC) } }],
  })
  const entries = res.map((r) => ({ pubkey: r.pubkey, account: decodeIdentity(r.account.data) }))
  identityScanCache = { at: Date.now(), entries }
  return entries
}

async function findIdentityByTokenId(tokenId: number): Promise<IdentityEntry | null> {
  const entries = await fetchAllIdentities()
  const hit = entries.find((e) => tokenIdFromMint(e.account.mint) === tokenId)
  if (hit) return hit
  // TTL 缓存可能刚被新铸造的 Identity 绕过:未命中时强制重扫一次再下结论
  const fresh = await fetchAllIdentities(true)
  return fresh.find((e) => tokenIdFromMint(e.account.mint) === tokenId) ?? null
}

let partScanCache: { at: number; parts: PartConfigAccount[] } | null = null

async function fetchAllPartConfigs(force = false): Promise<PartConfigAccount[]> {
  if (!force && partScanCache && Date.now() - partScanCache.at < SCAN_TTL_MS) {
    return partScanCache.parts
  }
  const res = await connection().getProgramAccounts(programId(), {
    filters: [{ memcmp: { offset: 0, bytes: base58Encode(PART_CONFIG_DISC) } }],
  })
  const parts = res.map((r) => decodePartConfig(r.account.data))
  partScanCache = { at: Date.now(), parts }
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
// 公开接口(与 persona.ts 完全一致的签名与语义)
// ------------------------------------------------------------

export { PERMISSION_SOCIAL, PersonaError, defaultAIProfile, personaCache }
export type { AgentSummary, EquipmentItem, LoadedPersona, WalletAssets }

/** base58 地址校验(32~44 位 base58 且能解析为 32 字节公钥) */
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
export async function resolveTokenId(owner: string): Promise<number> {
  const ownerPk = new PublicKey(owner) // 非法地址直接抛
  const [identityPda] = PublicKey.findProgramAddressSync([Buffer.from('identity'), ownerPk.toBuffer()], programId())
  const info = await connection().getAccountInfo(identityPda)
  if (!info) return 0
  return tokenIdFromMint(decodeIdentity(info.data).mint)
}

/** tokenId → owner 地址(GPA 扫 Identity 匹配 mint 前 8 字节;未来换索引器) */
export async function ownerOf(tokenId: number): Promise<string> {
  const hit = await findIdentityByTokenId(tokenId)
  if (!hit) throw new Error(`链上不存在 tokenId=${tokenId} 的 Agent`)
  return hit.account.owner
}

/** 链上 agentPermissions[tokenId][agent] 位掩码(无 AgentPermission PDA 返回 0n) */
export async function getAgentPermissions(tokenId: number, agentAddr: string): Promise<bigint> {
  const hit = await findIdentityByTokenId(tokenId)
  if (!hit) return 0n
  const agentPk = new PublicKey(agentAddr)
  const [permPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('agent-permission'), hit.pubkey.toBuffer(), agentPk.toBuffer()],
    programId(),
  )
  const info = await connection().getAccountInfo(permPda)
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
export async function fetchPersonaFromChain(tokenId: number): Promise<LoadedPersona> {
  const hit = await findIdentityByTokenId(tokenId)
  if (!hit) throw new Error(`链上不存在 tokenId=${tokenId} 的 Agent`)
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

/** 人格缓存:每个 tokenId 只装载一次,reload 接口强制刷新(与 EVM 侧共用语义) */
export async function loadPersona(tokenId: number, force = false): Promise<LoadedPersona> {
  if (!force) {
    const cached = personaCache.get(tokenId)
    if (cached) return cached
  }
  const persona = await fetchPersonaFromChain(tokenId)
  personaCache.set(tokenId, persona)
  return persona
}

export function getCachedPersona(tokenId: number): LoadedPersona | undefined {
  return personaCache.get(tokenId)
}

/** 列出全部已铸造的 Agent(心跳调度器每轮枚举用),按铸造时间(≈tokenId)升序 */
export async function listMintedAgents(): Promise<AgentSummary[]> {
  const entries = await fetchAllIdentities()
  return entries
    .sort((a, b) => a.account.mintedAt - b.account.mintedAt)
    .map((e) => ({ tokenId: tokenIdFromMint(e.account.mint), name: e.account.name, owner: e.account.owner, bio: '' }))
}

/** 列出最新铸造的 N 个 Agent(social-greeter 的 list_new_agents 用),按铸造时间倒序 */
export async function listRecentAgents(limit = 5): Promise<AgentSummary[]> {
  const all = await listMintedAgents()
  return all.slice(-limit).reverse()
}

/** 读链上装备(Identity.equipped)并概述主人持有量(Token-2022 账户余额) */
export async function getEquipment(tokenId: number): Promise<EquipmentItem[]> {
  const hit = await findIdentityByTokenId(tokenId)
  if (!hit) throw new Error(`链上不存在 tokenId=${tokenId} 的 Agent`)
  const parts = await fetchAllPartConfigs()
  const result: EquipmentItem[] = []
  for (let slot = 0; slot < hit.account.equipped.length; slot++) {
    const partMint = hit.account.equipped[slot]
    if (!partMint) continue // 空槽位
    const part = parts.find((p) => p.mint === partMint)
    // PartConfig 没有 name 字段,装备名前端按 part_id 对本地静态目录,对不上显示 Part #<id>;
    // 找不到 PartConfig(异常数据)时 partId 记 0
    const partId = part ? part.partId : 0
    const balance = await ownerPartBalance(hit.account.owner, partMint)
    result.push({ slot, collection: partMint, partId, balance })
  }
  return result
}

/** 主人在 Token-2022 上某 part mint 的持有量(遍历主人的 token 账户求和;装备在 escrow 时不计入) */
async function ownerPartBalance(owner: string, mint: string): Promise<number> {
  const accounts = await connection().getTokenAccountsByOwner(new PublicKey(owner), {
    programId: TOKEN_2022_PROGRAM_ID,
    mint: new PublicKey(mint),
  })
  let total = 0
  for (const { account } of accounts.value) {
    // Token-2022 账户基础布局与 SPL Token 一致:amount 在偏移 64(u64le);扩展字段在其后
    total += Number(account.data.readBigUInt64LE(64))
  }
  return total
}

/** 钱包资产:SOL 原生余额(lamports→SOL)+ USDC/USDT 暂留 0(Solana 阶段未接 SPL 稳定币) + DID 装备 */
export async function getWalletAssets(address: string, tokenId: number): Promise<WalletAssets> {
  const lamports = await connection().getBalance(new PublicKey(address))
  const equipment = await getEquipment(tokenId)
  return {
    address,
    nativeBalance: (lamports / 1e9).toString(),
    nativeSymbol: 'SOL',
    usdcBalance: '0', // TODO(Solana):接 USDC(Token-2022 账户解析)后填实际值
    usdtBalance: '0',
    equipment,
  }
}
