import { Buffer } from 'buffer'
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  type AccountInfo,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { keccak256, toBytes } from 'viem'
import tinyworldIdl from '../idl/tinyworld.json'
import { chainParts, partByChainId, SLOT_TO_CATEGORY } from './contracts'
import { getActiveChain } from '../store/chainConfigStore'
import { getPersonaMirror, putPersonaMirror } from './agentApi'
import {
  getActiveSolanaAddress,
  solanaSignAndSend,
  solanaSignTransaction,
  SolanaWalletError,
} from './walletSolana'
import type { ChainIdentityState, ChainPartState, MintedAgent } from './chain'
import type { Equipped } from '../types'

// ============================================================
// Solana 链交互层(tinyworld 程序,Token-2022)
// 与 lib/chain.ts(EVM)签名对齐,由 lib/chainDispatch.ts 按链族分发到这里。
//
// tokenId 语义:Solana 无数值 tokenId,定义 tokenId = u64(BN, little-endian,
// 取 identity.mint 公钥前 8 字节),确定性且唯一。反向查找(fetchAgentPublic)
// 用 getProgramAccounts 扫全部 Identity 账户再匹配——测试网规模可行,
// 未来数据量上来后应换索引器服务。
// ============================================================

interface IdlIx {
  name: string
  discriminator: number[]
  accounts: { name: string }[]
}

const IDL = tinyworldIdl as unknown as { instructions: IdlIx[] }
const IX = new Map(IDL.instructions.map((i) => [i.name, i]))

// Anchor 错误码 → IDL errors 表(6000 起连续)
const ANCHOR_ERRORS: Record<number, string> = {
  6000: '该名称已被占用,请换一个',
  6001: '该地址已铸造过 Agent(每地址限 1 枚)',
  6002: '名称不符合要求(1-64 字符)',
  6003: '插槽无效(0-3)',
  6004: '旧装备账户与链上已装备配件不匹配',
  6005: '配件插槽与目标插槽不匹配',
  6006: '该插槽没有装备中的配件',
  6007: '关闭身份前必须先卸下全部装备',
  6008: '只有 Agent 持有者本人可以操作',
  6009: '该配件尚未注册,请先注册',
  6010: '该配件已注册,不能重复注册',
  6011: '该配件已关闭铸造(mintable=false)',
  6012: '铸造数量超过该配件最大供应量',
  6013: '最大供应量必须大于 0',
  6014: '当前地址没有铸造权限(需程序 authority 或授权 minter)',
  6015: '无效的 agent(零地址或零权限)',
  6016: 'agent 权限位非法(仅允许 bit 0/1)',
  6017: '没有权限修改该 Agent 的人格配置',
  6018: '当前地址不是程序 authority',
  6019: 'arweave id 不合法(空串或 43 位 base64url)',
}

const DISC = {
  config: [155, 12, 170, 224, 30, 250, 204, 130],
  identity: [58, 132, 5, 12, 176, 164, 85, 112],
  minter: [28, 69, 107, 166, 41, 139, 205, 247],
  partConfig: [55, 8, 71, 138, 54, 158, 74, 25],
} as const

const discEquals = (data: Uint8Array, disc: readonly number[]) =>
  disc.every((b, i) => data[i] === b)

// ---------------- 基础工具 ----------------

function programId(): PublicKey {
  return new PublicKey(getActiveChain().identity)
}

function conn(): Connection {
  return new Connection(getActiveChain().rpc, 'confirmed')
}

const pda = (seeds: (Uint8Array | PublicKey)[]): PublicKey =>
  PublicKey.findProgramAddressSync(
    seeds.map((s) => (s instanceof PublicKey ? s.toBytes() : s)),
    programId(),
  )[0]

const identityPda = (owner: PublicKey | string): PublicKey =>
  pda([Buffer.from('identity'), typeof owner === 'string' ? new PublicKey(owner) : owner])

const nameRecordPda = (nameHash: Uint8Array): PublicKey => pda([Buffer.from('name-record'), nameHash])

const partConfigPda = (partId: number): PublicKey => pda([Buffer.from('part'), u64le(partId)])

const configPda = (): PublicKey => pda([Buffer.from('config')])

const mintAuthPda = (): PublicKey => pda([Buffer.from('mint-auth')])

const minterPda = (wallet: PublicKey | string): PublicKey =>
  pda([Buffer.from('minter'), typeof wallet === 'string' ? new PublicKey(wallet) : wallet])

const ata = (mint: PublicKey, owner: PublicKey, offCurve = false): PublicKey =>
  getAssociatedTokenAddressSync(mint, owner, offCurve, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)

function u64le(v: number | bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(v))
  return b
}

function u8b(v: number): Buffer {
  return Buffer.from([v & 0xff])
}

function borshString(s: string): Buffer {
  const t = Buffer.from(s, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(t.length)
  return Buffer.concat([len, t])
}

function ixData(name: string, ...args: Buffer[]): Buffer {
  const ix = IX.get(name)
  if (!ix) throw new Error(`IDL 缺少指令: ${name}`)
  return Buffer.concat([Buffer.from(ix.discriminator), ...args])
}

function ix(name: string, keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[], ...args: Buffer[]): TransactionInstruction {
  return new TransactionInstruction({ programId: programId(), keys, data: ixData(name, ...args) })
}

const signerKey = (pubkey: PublicKey, isWritable = false) => ({ pubkey, isSigner: true, isWritable })
const writableKey = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true })
const readonlyKey = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false })

/** 发送交易:Phantom 签名 + 前端自建 RPC 发送(带故障转移)
 *
 * 注意:不用 Phantom 的 signAndSendTransaction——它走 Phantom 中继节点,
 * 部分网络环境对其中继返回 403(实测表现为签名成功但"上链失败"),且无法换 RPC。
 * 这里统一 signTransaction 后由页面直连 chains 表配置的 RPC 发送,
 * 官方节点不可达时自动切 publicnode 备用(与 agent 侧 FailoverConnection 同思路)。
 */
async function sendTx(tx: Transaction, extraSigners: Keypair[] = []): Promise<string> {
  const wallet = new PublicKey(getActiveSolanaAddress() ?? '')
  tx.feePayer = wallet
  const latest = await latestBlockhash()
  tx.recentBlockhash = latest.blockhash
  let signed: Transaction
  if (extraSigners.length > 0) tx.partialSign(...extraSigners)
  try {
    signed = (await solanaSignTransaction(tx)) as Transaction
  } catch (err) {
    // 钱包不支持 signTransaction 时才退回中继发送
    if (err instanceof SolanaWalletError && err.code === 'UNSUPPORTED') {
      return sendViaWalletRelay(tx, latest)
    }
    throw err
  }
  const signature = await sendRawWithFailover(signed.serialize())
  await confirmWithFailover(signature, latest)
  return signature
}

/** RPC 端点列表:主端点 + 同链备用(官方 solana.com 域名间歇不可达) */
function rpcEndpoints(): string[] {
  const primary = getActiveChain().rpc
  const list = [primary]
  if (primary.includes('api.testnet.solana.com')) {
    list.push('https://solana-testnet-rpc.publicnode.com')
  }
  return [...new Set(list)]
}

async function latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  let lastErr: unknown = null
  for (const url of rpcEndpoints()) {
    try {
      return await new Connection(url, 'confirmed').getLatestBlockhash('confirmed')
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

async function sendRawWithFailover(raw: Uint8Array): Promise<string> {
  let lastErr: unknown = null
  for (const url of rpcEndpoints()) {
    try {
      return await new Connection(url, 'confirmed').sendRawTransaction(raw)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

async function confirmWithFailover(
  signature: string,
  latest: { blockhash: string; lastValidBlockHeight: number },
): Promise<void> {
  let lastErr: unknown = null
  for (const url of rpcEndpoints()) {
    try {
      await new Connection(url, 'confirmed').confirmTransaction(
        { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
        'confirmed',
      )
      return
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

/** 兜底:钱包不支持 signTransaction 时退回 Phantom 中继发送 */
async function sendViaWalletRelay(
  tx: Transaction,
  latest: { blockhash: string; lastValidBlockHeight: number },
): Promise<string> {
  const signature = await solanaSignAndSend(tx)
  await confirmWithFailover(signature, latest)
  return signature
}

// ---------------- 账户解码(Borsh,无 anchor 运行时) ----------------

class Reader {
  private o = 0
  constructor(private buf: Buffer) {}
  u8(): number {
    return this.buf[this.o++]
  }
  bytes(n: number): Buffer {
    const b = this.buf.subarray(this.o, this.o + n)
    this.o += n
    return Buffer.from(b)
  }
  pubkey(): PublicKey {
    return new PublicKey(this.bytes(32))
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.o)
    this.o += 4
    return v
  }
  string(): string {
    const len = this.u32()
    return this.bytes(len).toString('utf8')
  }
  optionPubkey(): PublicKey | null {
    return this.u8() ? this.pubkey() : null
  }
}

interface IdentityAccount {
  owner: PublicKey
  mint: PublicKey
  name: string
  personaHash: Buffer
  arweaveId: string
  equipped: (PublicKey | null)[]
}

interface PartConfigAccount {
  partId: bigint
  mint: PublicKey
  slot: number
  rarity: number
  maxSupply: bigint
  mintable: boolean
}

function decodeIdentity(data: Uint8Array): IdentityAccount {
  const r = new Reader(Buffer.from(data))
  r.bytes(8) // discriminator
  const owner = r.pubkey()
  const mint = r.pubkey()
  const name = r.string()
  r.bytes(32) // name_hash
  const personaHash = r.bytes(32)
  const arweaveId = r.string()
  const equipped = [r.optionPubkey(), r.optionPubkey(), r.optionPubkey(), r.optionPubkey()]
  return { owner, mint, name, personaHash, arweaveId, equipped }
}

function decodePartConfig(data: Uint8Array): PartConfigAccount {
  const r = new Reader(Buffer.from(data))
  r.bytes(8)
  const partId = (() => {
    const b = r.bytes(8)
    let v = 0n
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i])
    return v
  })()
  const mint = r.pubkey()
  const slot = r.u8()
  const rarity = r.u8()
  const maxB = r.bytes(8)
  let maxSupply = 0n
  for (let i = 7; i >= 0; i--) maxSupply = (maxSupply << 8n) | BigInt(maxB[i])
  const mintable = r.u8() === 1
  return { partId, mint, slot, rarity, maxSupply, mintable }
}

function decodeConfigAuthority(data: Uint8Array): PublicKey {
  const r = new Reader(Buffer.from(data))
  r.bytes(8)
  return r.pubkey()
}

function decodeMinter(data: Uint8Array): { wallet: PublicKey; enabled: boolean } {
  const r = new Reader(Buffer.from(data))
  r.bytes(8)
  const wallet = r.pubkey()
  const enabled = r.u8() === 1
  return { wallet, enabled }
}

// ---------------- tokenId 派生 / 反向查找 ----------------

/** tokenId = u64 LE(identity.mint 前 8 字节);测试网规模下远小于 2^53,number 安全 */
export function tokenIdFromMint(mint: PublicKey): number {
  const b = mint.toBytes()
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i])
  return Number(v)
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

async function fetchProgramAccounts(): Promise<{ pubkey: PublicKey; account: AccountInfo<Buffer> }[]> {
  // 测试网规模:直接扫程序全部账户,客户端按 discriminator 过滤(未来换索引器)
  const all = await conn().getProgramAccounts(programId())
  return all as { pubkey: PublicKey; account: AccountInfo<Buffer> }[]
}

async function fetchAllIdentities(): Promise<{ pubkey: PublicKey; identity: IdentityAccount }[]> {
  const all = await fetchProgramAccounts()
  return all
    .filter(({ account }) => discEquals(account.data, DISC.identity))
    .map(({ pubkey, account }) => ({ pubkey, identity: decodeIdentity(account.data) }))
}

async function fetchAllPartConfigs(): Promise<Map<number, PartConfigAccount>> {
  const all = await fetchProgramAccounts()
  const map = new Map<number, PartConfigAccount>()
  for (const { account } of all) {
    if (!discEquals(account.data, DISC.partConfig)) continue
    const cfg = decodePartConfig(account.data)
    map.set(Number(cfg.partId), cfg)
  }
  return map
}

async function findIdentityByTokenId(tokenId: number): Promise<IdentityAccount | null> {
  const list = await fetchAllIdentities()
  return list.find(({ identity }) => tokenIdFromMint(identity.mint) === tokenId)?.identity ?? null
}

/** 从本地装备目录读某个地址的 Token-2022 余额(mint → amount) */
async function fetchPartBalances(owner: PublicKey): Promise<Map<number, number>> {
  const configs = await fetchAllPartConfigs()
  const mintToPartId = new Map<string, number>()
  configs.forEach((cfg, partId) => mintToPartId.set(cfg.mint.toBase58(), partId))
  const tokenAccounts = await conn().getTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })
  const balances = new Map<number, number>()
  for (const { account } of tokenAccounts.value) {
    const data = Buffer.from(account.data)
    const mint = new PublicKey(data.subarray(0, 32)).toBase58()
    const partId = mintToPartId.get(mint)
    if (partId == null) continue
    // token-2022 账户基础布局:mint(32) owner(32) amount(u64 LE @64),扩展不影响该偏移
    const prev = balances.get(partId) ?? 0
    balances.set(partId, prev + Number(data.readBigUInt64LE(64)))
  }
  return balances
}

const emptyEquipped = (): Equipped => ({ head: null, body: null, accessory: null, pet: null })

function equippedToLocal(identity: IdentityAccount, mintToPartId: Map<string, number>): Equipped {
  const equipped = emptyEquipped()
  identity.equipped.forEach((mint, slot) => {
    if (!mint) return
    const partId = mintToPartId.get(mint.toBase58())
    if (partId == null) return
    const part = partByChainId(partId)
    const category = SLOT_TO_CATEGORY[slot]
    if (part && category) equipped[category] = part.localId
  })
  return equipped
}

// ---------------- 只读 ----------------

/** 读取地址的链上身份与配件资产(Identity PDA + Token-2022 余额) */
export async function fetchChainState(address: string): Promise<ChainIdentityState> {
  const owner = new PublicKey(address)
  const [identityInfo, configs, balances] = await Promise.all([
    conn().getAccountInfo(identityPda(owner)),
    fetchAllPartConfigs(),
    fetchPartBalances(owner),
  ])
  let tokenId = 0
  let didName = ''
  let equipped = emptyEquipped()
  if (identityInfo && discEquals(identityInfo.data, DISC.identity)) {
    const identity = decodeIdentity(identityInfo.data)
    const mintToPartId = new Map<string, number>()
    configs.forEach((cfg, partId) => mintToPartId.set(cfg.mint.toBase58(), partId))
    tokenId = tokenIdFromMint(identity.mint)
    didName = identity.name
    equipped = equippedToLocal(identity, mintToPartId)
  }
  const parts = chainParts.map((p) => ({
    id: p.id,
    localId: p.localId,
    slot: p.slot,
    name: p.name,
    rarity: p.rarity,
    balance: balances.get(p.id) ?? 0,
  }))
  return { tokenId, didName, equipped, parts }
}

/** 统计任意地址持有的装备总数(Token-2022 账户余额求和;个人主页访客指标用) */
export async function fetchOwnedPartCount(address: string): Promise<number> {
  const balances = await fetchPartBalances(new PublicKey(address))
  let sum = 0
  balances.forEach((n) => (sum += n))
  return sum
}

/** 名称查重:NameRecord PDA 存在 → 被占用;再扫 Identity 名称兜底(防 NameRecord 缺失) */
export async function checkNameAvailable(name: string): Promise<boolean> {
  const hash = toBytes(keccak256(toBytes(name.toLowerCase())))
  const record = await conn().getAccountInfo(nameRecordPda(hash))
  if (record) return false
  const identities = await fetchAllIdentities()
  const lower = name.toLowerCase()
  return !identities.some(({ identity }) => identity.name.toLowerCase() === lower)
}

/** 读取全部已铸造的 Agent(GPA 扫 Identity) */
export async function fetchMintedAgents(): Promise<MintedAgent[]> {
  const list = await fetchAllIdentities()
  return list.map(({ identity }) => ({
    tokenId: tokenIdFromMint(identity.mint),
    name: identity.name,
    owner: identity.owner.toBase58(),
  }))
}

/** 读取任意 Agent 的公开信息;不存在时抛错(Solana 无 bio 字段,恒为空串) */
export async function fetchAgentPublic(tokenId: number): Promise<{
  tokenId: number
  name: string
  owner: string
  bio: string
  equipped: Equipped
}> {
  const identity = await findIdentityByTokenId(tokenId)
  if (!identity) throw new Error(`Agent #${tokenId} 不存在`)
  const configs = await fetchAllPartConfigs()
  const mintToPartId = new Map<string, number>()
  configs.forEach((cfg, partId) => mintToPartId.set(cfg.mint.toBase58(), partId))
  return { tokenId, name: identity.name, owner: identity.owner.toBase58(), bio: '', equipped: equippedToLocal(identity, mintToPartId) }
}

const PERSONA_DATA_PREFIX = 'data:application/json;base64,'

const decodePersonaJson = (uri: string): string => {
  if (!uri.startsWith(PERSONA_DATA_PREFIX)) throw new Error('人格配置 URI 格式异常')
  return decodeURIComponent(escape(atob(uri.slice(PERSONA_DATA_PREFIX.length))))
}

/**
 * 读取链上人格(Solana 镜像模式):
 * Identity.persona_hash → GET <agent-api>/personas/<0xhash> 拿 JSON 原文
 * → 重组 data URI 返回,ProfilePage 解析逻辑零改动。hash 全 0 或镜像 404 均按"未设置人格"返回空 uri。
 */
export async function fetchPersona(tokenId: number): Promise<{ uri: string; contentHash: `0x${string}` }> {
  const identity = await findIdentityByTokenId(tokenId)
  if (!identity) return { uri: '', contentHash: '0x' }
  if (identity.personaHash.every((b) => b === 0)) return { uri: '', contentHash: '0x' }
  const contentHash = `0x${toHex(identity.personaHash)}` as `0x${string}`
  const json = await getPersonaMirror(contentHash).catch(() => null)
  if (json == null) return { uri: '', contentHash } // 镜像 404:按未设置人格处理
  const uri = `${PERSONA_DATA_PREFIX}${btoa(unescape(encodeURIComponent(json)))}`
  return { uri, contentHash }
}

/** 读取全部 120 件装备的链上注册状态与供应量(PartConfig PDA + mint supply) */
export async function fetchPartStates(): Promise<ChainPartState[]> {
  const configs = await fetchAllPartConfigs()
  return Promise.all(
    chainParts.map(async (p) => {
      const cfg = configs.get(p.id)
      if (!cfg) {
        return { id: p.id, localId: p.localId, slot: p.slot, name: p.name, rarity: p.rarity, maxSupply: 0, mintable: false, registered: false, totalSupply: 0 }
      }
      const supply = await conn().getTokenSupply(cfg.mint)
      return {
        id: p.id,
        localId: p.localId,
        slot: p.slot,
        name: p.name,
        rarity: p.rarity,
        maxSupply: Number(cfg.maxSupply),
        mintable: cfg.mintable,
        registered: true,
        totalSupply: Number(supply.value.amount),
      }
    }),
  )
}

/** 判断地址是否为程序 authority(Config PDA) */
export async function isPartsOwner(account: string): Promise<boolean> {
  const info = await conn().getAccountInfo(configPda())
  if (!info) return false
  return decodeConfigAuthority(info.data).toBase58() === account
}

/** 判断地址是否可铸造:authority 本人,或存在 enabled 的 Minter PDA */
export async function isPartsMinter(account: string): Promise<boolean> {
  const [configInfo, minterInfo] = await Promise.all([conn().getAccountInfo(configPda()), conn().getAccountInfo(minterPda(account))])
  if (configInfo && decodeConfigAuthority(configInfo.data).toBase58() === account) return true
  if (!minterInfo || !discEquals(minterInfo.data, DISC.minter)) return false
  return decodeMinter(minterInfo.data).enabled
}

// ---------------- 写入(全部返回 base58 signature) ----------------

/**
 * 铸造 Agent 主身份。profileURI 参数忽略——Solana 程序无此字段(bio 不上链),
 * 函数签名与 EVM 侧保持一致。
 */
export async function mintIdentity(owner: string, name: string, _profileURI: string): Promise<string> {
  const ownerPk = new PublicKey(owner)
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 64) throw new Error('名称不符合要求(1-64 字符)')
  const mintKp = Keypair.generate()
  const tx = new Transaction().add(
    ix(
      'mint_identity',
      [
        signerKey(ownerPk, true),
        writableKey(identityPda(ownerPk)),
        writableKey(nameRecordPda(toBytes(keccak256(toBytes(trimmed.toLowerCase()))))),
        signerKey(mintKp.publicKey, true),
        writableKey(ata(mintKp.publicKey, ownerPk)),
        readonlyKey(mintAuthPda()),
        readonlyKey(configPda()),
        readonlyKey(TOKEN_2022_PROGRAM_ID),
        readonlyKey(ASSOCIATED_TOKEN_PROGRAM_ID),
        readonlyKey(SystemProgram.programId),
        // 可选铸造费接收账户(仅费率>0 时必须=config authority;Option 占位传程序 ID = None)
        readonlyKey(programId()),
      ],
      borshString(trimmed),
    ),
  )
  return sendTx(tx, [mintKp])
}

/** 穿戴:读 PartConfig 校验 slot,组装 equip(程序自动换装:退旧装新) */
export async function equipPart(owner: string, _tokenId: number, slot: number, partChainId: number): Promise<string> {
  const ownerPk = new PublicKey(owner)
  const cfgInfo = await conn().getAccountInfo(partConfigPda(partChainId))
  if (!cfgInfo || !discEquals(cfgInfo.data, DISC.partConfig)) throw new Error('该配件尚未注册,请先注册')
  const cfg = decodePartConfig(cfgInfo.data)
  if (cfg.slot !== slot) throw new Error('配件插槽与目标插槽不匹配')
  const idPda = identityPda(ownerPk)
  const identityInfo = await conn().getAccountInfo(idPda)
  if (!identityInfo) throw new Error('尚未铸造 Agent 身份')
  const identity = decodeIdentity(identityInfo.data)
  const ownerAta = ata(cfg.mint, ownerPk)
  const escrowAta = ata(cfg.mint, idPda, true)
  // 插槽已占用时传入旧件退回账户;空插槽用新件账户占位(程序忽略)
  const oldMint = identity.equipped[slot] ?? cfg.mint
  const oldEscrow = identity.equipped[slot] ? ata(oldMint, idPda, true) : escrowAta
  const oldOwnerAta = identity.equipped[slot] ? ata(oldMint, ownerPk) : ownerAta
  const tx = new Transaction().add(
    ix(
      'equip',
      [
        writableKey(idPda),
        signerKey(ownerPk, true),
        readonlyKey(partConfigPda(partChainId)),
        writableKey(cfg.mint),
        writableKey(ownerAta),
        writableKey(escrowAta),
        writableKey(oldMint),
        writableKey(oldEscrow),
        writableKey(oldOwnerAta),
        readonlyKey(TOKEN_2022_PROGRAM_ID),
        readonlyKey(ASSOCIATED_TOKEN_PROGRAM_ID),
        readonlyKey(SystemProgram.programId),
      ],
      u64le(partChainId),
      u8b(slot),
    ),
  )
  return sendTx(tx)
}

/** 卸下配件(从 escrow 转回持有者钱包) */
export async function unequipPart(owner: string, _tokenId: number, slot: number): Promise<string> {
  const ownerPk = new PublicKey(owner)
  const idPda = identityPda(ownerPk)
  const identityInfo = await conn().getAccountInfo(idPda)
  if (!identityInfo) throw new Error('尚未铸造 Agent 身份')
  const identity = decodeIdentity(identityInfo.data)
  const mint = identity.equipped[slot]
  if (!mint) throw new Error('该插槽没有装备中的配件')
  const tx = new Transaction().add(
    ix(
      'unequip',
      [
        writableKey(idPda),
        signerKey(ownerPk, true),
        writableKey(mint),
        writableKey(ata(mint, idPda, true)),
        writableKey(ata(mint, ownerPk)),
        readonlyKey(TOKEN_2022_PROGRAM_ID),
      ],
      u8b(slot),
    ),
  )
  return sendTx(tx)
}

/**
 * 人格上链(镜像模式):uri 为 data:application/json base64,
 * 解出 JSON 原文 PUT 到 agent 服务 /personas/<0xhash>,再 update_persona(hash, '')
 * (空 arweave_id 合法,表示镜像模式)。contentHash 为 0x hex keccak,程序要 32 字节数组。
 */
export async function setPersonaOnChain(
  owner: string,
  _tokenId: number,
  uri: string,
  contentHash: `0x${string}`,
): Promise<string> {
  const json = decodePersonaJson(uri)
  if (keccak256(toBytes(json)) !== contentHash.toLowerCase()) throw new Error('人格配置哈希校验失败')
  await putPersonaMirror(contentHash, json)
  const ownerPk = new PublicKey(owner)
  const idPda = identityPda(ownerPk)
  const tx = new Transaction().add(
    ix(
      'update_persona',
      [
        writableKey(idPda),
        signerKey(ownerPk),
        // agent_permission 是 Option<Account>:anchor 约定传程序 ID 表示 None。
        // 传未初始化的 PDA 会触发 AccountNotInitialized(3012) 模拟失败(实测)。
        // owner 自签走直通分支,无需 agent 授权账户。
        readonlyKey(programId()),
      ],
      Buffer.from(toBytes(contentHash)),
      borshString(''),
    ),
  )
  return sendTx(tx)
}

/** 单条注册配件(需程序 authority) */
export async function registerPart(owner: string, chainId: number, slot: number, rarity: number, maxSupply: number): Promise<string> {
  const ownerPk = new PublicKey(owner)
  const mintKp = Keypair.generate()
  const tx = new Transaction().add(
    ix(
      'register_part',
      [
        readonlyKey(configPda()),
        signerKey(ownerPk, true),
        writableKey(partConfigPda(chainId)),
        signerKey(mintKp.publicKey, true),
        readonlyKey(mintAuthPda()),
        readonlyKey(TOKEN_2022_PROGRAM_ID),
        readonlyKey(SystemProgram.programId),
      ],
      u64le(chainId),
      u8b(slot),
      u8b(rarity),
      u64le(maxSupply),
    ),
  )
  return sendTx(tx, [mintKp])
}

export interface RegisterProgress {
  current: number
  total: number
  txHash: string | null
  chainId: number | null
}

/** 批量注册(顺序逐笔;通过 onProgress 回调报告进度) */
export async function registerPartsBatch(
  owner: string,
  parts: { chainId: number; slot: number; rarity: number; maxSupply: number; name: string }[],
  onProgress?: (p: RegisterProgress) => void,
): Promise<string[]> {
  const hashes: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    onProgress?.({ current: i + 1, total: parts.length, txHash: null, chainId: part.chainId })
    const hash = await registerPart(owner, part.chainId, part.slot, part.rarity, part.maxSupply)
    hashes.push(hash)
    onProgress?.({ current: i + 1, total: parts.length, txHash: hash, chainId: part.chainId })
  }
  return hashes
}

/** 批量铸造:程序是单笔 mint_part(part_id,to,amount),这里按 id 循环发多笔,返回最后一笔 signature */
export async function mintPartsBatch(owner: string, to: string, ids: bigint[], amounts: bigint[]): Promise<string> {
  if (ids.length === 0 || amounts.length === 0 || ids.length !== amounts.length) {
    throw new Error('铸造参数不能为空且 ids 与 amounts 长度必须一致')
  }
  const ownerPk = new PublicKey(owner)
  const toPk = new PublicKey(to)
  let lastSignature = ''
  for (let i = 0; i < ids.length; i++) {
    const partId = Number(ids[i])
    const cfgInfo = await conn().getAccountInfo(partConfigPda(partId))
    if (!cfgInfo || !discEquals(cfgInfo.data, DISC.partConfig)) throw new Error(`配件 #${partId} 尚未注册`)
    const cfg = decodePartConfig(cfgInfo.data)
    const tx = new Transaction().add(
      ix(
        'mint_part',
        [
          readonlyKey(configPda()),
          signerKey(ownerPk, true),
          writableKey(minterPda(ownerPk)), // authority 调用时可为任意地址(程序允许不存在)
          writableKey(partConfigPda(partId)),
          writableKey(cfg.mint),
          readonlyKey(toPk),
          writableKey(ata(cfg.mint, toPk)),
          readonlyKey(mintAuthPda()),
          readonlyKey(TOKEN_2022_PROGRAM_ID),
          readonlyKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          readonlyKey(SystemProgram.programId),
        ],
        u64le(partId),
        Buffer.from(toPk.toBytes()),
        u64le(amounts[i]),
      ),
    )
    lastSignature = await sendTx(tx)
  }
  return lastSignature
}

// ---------------- 错误解释 ----------------

/** 把 Solana/Anchor 错误翻译成中文提示 */
export function explainSolanaChainError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // Anchor 程序化错误:"Error Code: Xxx. Error Number: 6000." 或 logs 里的 "custom program error: 0x1770"
  const codeMatch = /Error Code: (\w+)/.exec(msg)
  if (codeMatch) {
    const table: Record<string, string> = {
      NameTaken: '该名称已被占用,请换一个',
      AlreadyHasDID: '该地址已铸造过 Agent(每地址限 1 枚)',
      InvalidName: '名称不符合要求(1-64 字符)',
      NotTokenOwner: '只有 Agent 持有者本人可以操作',
      NotAuthorized: '没有权限修改该 Agent 的人格配置',
      NothingEquipped: '该插槽没有装备中的配件',
      SlotsNotEmpty: '关闭身份前必须先卸下全部装备',
      PartNotRegistered: '该配件尚未注册,请先注册',
      PartAlreadyRegistered: '该配件已注册,不能重复注册',
      NotMintable: '该配件已关闭铸造(mintable=false)',
      ExceedsMaxSupply: '铸造数量超过该配件最大供应量',
      InvalidMaxSupply: '最大供应量必须大于 0',
      UnauthorizedMinter: '当前地址没有铸造权限(需程序 authority 或授权 minter)',
      Unauthorized: '当前地址不是程序 authority',
      InvalidSlot: '插槽无效(0-3)',
      SlotMismatch: '配件插槽与目标插槽不匹配',
      SlotOccupied: '旧装备账户与链上已装备配件不匹配',
      InvalidArweaveId: 'arweave id 不合法(空串或 43 位 base64url)',
    }
    const mapped = table[codeMatch[1]]
    if (mapped) return mapped
  }
  const numMatch = /custom program error: 0x([0-9a-fA-F]+)/.exec(msg)
  if (numMatch) {
    const mapped = ANCHOR_ERRORS[parseInt(numMatch[1], 16)]
    if (mapped) return mapped
  }
  if (/User rejected|rejected|denied|declined|cancel/i.test(msg)) return '你取消了钱包操作'
  if (/Blockhash not found|expired|timeout/i.test(msg)) return '交易确认超时,请重试(测试网拥堵时可能发生)'
  if (/InsufficientFunds|insufficient/i.test(msg)) return '钱包 SOL 余额不足,请先领取测试币'
  return `链上操作失败: ${msg.length > 120 ? msg.slice(0, 120) + '…' : msg}`
}
