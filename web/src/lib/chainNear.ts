import { keccak256, toBytes } from 'viem'
import { chainParts, partByChainId, SLOT_TO_CATEGORY } from './contracts'
import { getActiveChain } from '../store/chainConfigStore'
import { getPersonaMirror, putPersonaMirror } from './agentApi'
import { getActiveNearAccount, isValidNearAddress, nearFunctionCall, nearSignAndSend } from './walletNear'
import type { ChainIdentityState, ChainPartState, MintedAgent } from './chain'
import type { Equipped } from '../types'

// ============================================================
// NEAR 链交互层(tinyworld 合约:testnet,身份 NEP-171 Soulbound + 装备部件)
// 与 lib/chain.ts(EVM)、lib/chainSolana.ts(Solana)签名对齐,由 lib/chainDispatch.ts
// 按链族分发到这里。
//
// 读:裸 fetch 打 NEAR JSON-RPC(call_function,result 为字节数组 → JSON),
// 不引 near-api-js;120 件装备的余额/注册状态用 JSON-RPC 批量请求一次发完。
// 写:wallet-selector 的 signAndSendTransactions(钱包签名 + 广播一步完成),
// 返回 NEAR tx hash。
//
// 与 EVM/Solana 的机制差异:
// - token_id 是合约内递增整数(从 1 开始),语义与 EVM _nextTokenId 一致;
// - 铸币费通过 attached deposit 收取(get_current_fee 查询后原样传入);
// - minter 白名单合约侧无查询视图,管理员判定只能精确识别合约 owner。
// ============================================================

// ---------------- 基础工具 ----------------

function contractId(): string {
  return getActiveChain().identity
}

/** 当前连接的 NEAR 账户(account_id);未连接或登录身份不一致时抛错 */
function requireNearAccount(owner?: string): string {
  const account = owner ?? getActiveNearAccount()
  if (!account || !isValidNearAddress(account)) throw new Error('NEAR 钱包未连接,请先连接 NEAR 钱包')
  const connected = getActiveNearAccount()
  if (connected && connected !== account) {
    throw new Error('当前 NEAR 账户已切换,与登录身份不一致,请重新连接钱包后再试')
  }
  return account
}

const u64 = (v: number | bigint) => String(v)

// ---------------- 只读(RPC) ----------------

interface RpcResponse<T> {
  jsonrpc: string
  id: number
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

interface CallFunctionResult {
  block_hash: string
  block_height: number
  logs: string[]
  /** 视图返回值字节;返回单元值/None 时该字段缺省 */
  result?: number[]
}

function encodeArgs(args: Record<string, unknown>): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(args))))
}

function decodeResult<T>(result: CallFunctionResult | undefined): T | null {
  const bytes = result?.result
  if (!bytes || bytes.length === 0) return null
  return JSON.parse(String.fromCharCode(...bytes)) as T
}

async function nearRpc<T>(method: string, params: unknown, id = 1): Promise<T> {
  // 主端点失败时轮换备用端点(rpc.testnet.near.org 官方端点已宣布弃用,仅作兜底)
  const endpoints = [getActiveChain().rpc, 'https://rpc.testnet.near.org']
  let lastErr: unknown = null
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`NEAR RPC 请求失败(${res.status})`)
      const data = (await res.json()) as RpcResponse<T>
      if (data.error) throw new Error(`NEAR RPC 错误: ${data.error.message}`)
      if (data.result === undefined) throw new Error('NEAR RPC 返回格式异常')
      return data.result
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 单个 view 方法;合约返回 None/单元值时得到 null */
async function callView<T>(methodName: string, args: Record<string, unknown>): Promise<T | null> {
  const result = await nearRpc<CallFunctionResult>('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId(),
    method_name: methodName,
    args_base64: encodeArgs(args),
  })
  return decodeResult<T>(result)
}

/** 并发受限的批量 view 调用(NEAR RPC 不支持 JSON 批量请求,用并发池代替;单条失败不拖垮整批) */
async function callViewBatch<T>(methodName: string, argList: Record<string, unknown>[], concurrency = 8): Promise<(T | null)[]> {
  const out: (T | null)[] = new Array(argList.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < argList.length) {
      const i = next++
      out[i] = await callView<T>(methodName, argList[i]).catch(() => null)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, argList.length) }, worker))
  return out
}

// ---------------- 合约视图类型 ----------------

interface AgentView {
  account_id: string
  permissions: number
}

interface IdentityView {
  token_id: string // U64 → 字符串
  owner_id: string
  name: string
  persona_hash: string // 64 位 hex,无前缀;全 0 = 未设置
  persona_arweave_id: string
  equipped: (string | null)[] // 4 项,U64 字符串或 null
  unlocked: boolean
  agents: AgentView[]
  minted_at: string
}

interface PartView {
  slot: number
  rarity: number
  max_supply: string
  total_supply: string
  mintable: boolean
  registered: boolean
}

interface TokenListItem {
  token_id: string
  owner_id: string
}

const emptyEquipped = (): Equipped => ({ head: null, body: null, accessory: null, pet: null })

function equippedToLocal(identity: IdentityView): Equipped {
  const equipped = emptyEquipped()
  identity.equipped.forEach((partIdStr, slot) => {
    if (!partIdStr) return
    const part = partByChainId(Number(partIdStr))
    const category = SLOT_TO_CATEGORY[slot]
    if (part && category) equipped[category] = part.localId
  })
  return equipped
}

/** 枚举全部 token(nft_tokens 分页,每页 100);测试网规模可行,未来换索引器 */
async function fetchAllTokenIds(): Promise<TokenListItem[]> {
  const out: TokenListItem[] = []
  const pageSize = 100
  for (let from = 0; ; from += pageSize) {
    const page = await callView<TokenListItem[]>('nft_tokens', {
      from_index: String(from),
      limit: pageSize,
    })
    if (!page || page.length === 0) break
    out.push(...page)
    if (page.length < pageSize) break
  }
  return out
}

/** 全量身份(分页枚举 token + 批量 get_identity);名称查重/广场列表共用 */
async function fetchAllIdentities(): Promise<IdentityView[]> {
  const tokens = await fetchAllTokenIds()
  if (tokens.length === 0) return []
  const views = await callViewBatch<IdentityView>(
    'get_identity',
    tokens.map((t) => ({ token_id: t.token_id })),
  )
  return views.filter((v): v is IdentityView => v !== null)
}

// ---------------- 只读(业务面,签名对齐 chain.ts) ----------------

/** 读取地址的链上身份与配件资产(get_identity_by_owner + 部件余额批量查询) */
export async function fetchChainState(address: string): Promise<ChainIdentityState> {
  const account = requireNearAccount(address)
  const [identity, balances] = await Promise.all([
    callView<IdentityView>('get_identity_by_owner', { account_id: account }),
    callViewBatch<string>('part_balance_of', chainParts.map((p) => ({ account_id: account, part_id: u64(p.id) }))),
  ])
  let tokenId = 0
  let didName = ''
  let equipped = emptyEquipped()
  if (identity) {
    tokenId = Number(identity.token_id)
    didName = identity.name
    equipped = equippedToLocal(identity)
  }
  const parts = chainParts.map((p, i) => ({
    id: p.id,
    localId: p.localId,
    slot: p.slot,
    name: p.name,
    rarity: p.rarity,
    balance: Number(balances[i] ?? '0'),
  }))
  return { tokenId, didName, equipped, parts }
}

/** 统计任意地址持有的装备总数(个人主页访客指标用) */
export async function fetchOwnedPartCount(address: string): Promise<number> {
  const account = requireNearAccount(address)
  const balances = await callViewBatch<string>(
    'part_balance_of',
    chainParts.map((p) => ({ account_id: account, part_id: u64(p.id) })),
  )
  return balances.reduce((sum, b) => sum + Number(b ?? '0'), 0)
}

/** 名称查重:合约无按名称查询的视图,枚举全部身份比对(测试网规模可行) */
export async function checkNameAvailable(name: string): Promise<boolean> {
  const lower = name.toLowerCase()
  const identities = await fetchAllIdentities()
  return !identities.some((identity) => identity.name.toLowerCase() === lower)
}

/** 读取全部已铸造的 Agent(nft_tokens 枚举 + 批量 get_identity) */
export async function fetchMintedAgents(): Promise<MintedAgent[]> {
  const identities = await fetchAllIdentities()
  return identities.map((identity) => ({
    tokenId: Number(identity.token_id),
    name: identity.name,
    owner: identity.owner_id,
  }))
}

/** 读取任意 Agent 的公开信息;不存在时抛错(NEAR 无 bio 字段,恒为空串) */
export async function fetchAgentPublic(tokenId: number): Promise<{
  tokenId: number
  name: string
  owner: string
  bio: string
  equipped: Equipped
}> {
  const identity = await callView<IdentityView>('get_identity', { token_id: u64(tokenId) })
  if (!identity) throw new Error(`Agent #${tokenId} 不存在`)
  return { tokenId, name: identity.name, owner: identity.owner_id, bio: '', equipped: equippedToLocal(identity) }
}

/** 批量读取多个 Agent 的公开信息(社交广场用);一次批量 get_identity,只返回找到的 */
export async function fetchAgentsPublic(tokenIds: number[]): Promise<{
  tokenId: number
  name: string
  owner: string
  bio: string
  equipped: Equipped
}[]> {
  if (tokenIds.length === 0) return []
  const views = await callViewBatch<IdentityView>(
    'get_identity',
    tokenIds.map((t) => ({ token_id: u64(t) })),
  )
  return views
    .map((identity, i) => ({ identity, tokenId: tokenIds[i] }))
    .filter((x): x is { identity: IdentityView; tokenId: number } => x.identity !== null)
    .map(({ identity, tokenId }) => ({
      tokenId,
      name: identity.name,
      owner: identity.owner_id,
      bio: '',
      equipped: equippedToLocal(identity),
    }))
}

const PERSONA_DATA_PREFIX = 'data:application/json;base64,'

const decodePersonaJson = (uri: string): string => {
  if (!uri.startsWith(PERSONA_DATA_PREFIX)) throw new Error('人格配置 URI 格式异常')
  return decodeURIComponent(escape(atob(uri.slice(PERSONA_DATA_PREFIX.length))))
}

/**
 * 读取链上人格(镜像模式,与 Solana 一致):
 * Identity.persona_hash → GET <agent-api>/personas/<0xhash> 拿 JSON 原文
 * → 重组 data URI 返回,ProfilePage 解析逻辑零改动。hash 全 0 或镜像 404 均按"未设置人格"返回空 uri。
 */
export async function fetchPersona(tokenId: number): Promise<{ uri: string; contentHash: `0x${string}` }> {
  const identity = await callView<IdentityView>('get_identity', { token_id: u64(tokenId) })
  if (!identity || !identity.persona_hash || /^0+$/.test(identity.persona_hash)) {
    return { uri: '', contentHash: '0x' }
  }
  const contentHash = `0x${identity.persona_hash}` as `0x${string}`
  const json = await getPersonaMirror(contentHash).catch(() => null)
  if (json == null) return { uri: '', contentHash } // 镜像 404:按未设置人格处理
  const uri = `${PERSONA_DATA_PREFIX}${btoa(unescape(encodeURIComponent(json)))}`
  return { uri, contentHash }
}

/** 读取全部装备的链上注册状态与供应量(get_part 批量查询) */
export async function fetchPartStates(): Promise<ChainPartState[]> {
  const views = await callViewBatch<PartView>(
    'get_part',
    chainParts.map((p) => ({ part_id: u64(p.id) })),
  )
  return chainParts.map((p, i) => {
    const view = views[i]
    if (!view) {
      return { id: p.id, localId: p.localId, slot: p.slot, name: p.name, rarity: p.rarity, maxSupply: 0, mintable: false, registered: false, totalSupply: 0 }
    }
    return {
      id: p.id,
      localId: p.localId,
      slot: p.slot,
      name: p.name,
      rarity: p.rarity,
      maxSupply: Number(view.max_supply),
      mintable: view.mintable,
      registered: view.registered,
      totalSupply: Number(view.total_supply),
    }
  })
}

/** 判断地址是否为合约 owner(get_owner) */
export async function isPartsOwner(account: string): Promise<boolean> {
  const owner = await callView<string>('get_owner', {})
  return owner === account
}

/** NEAR 合约的 minters 白名单无查询视图,只能精确识别 owner;
 *  被授予 minter 的账户 mint_part 由合约执行期校验(失败时报"not minter") */
export async function isPartsMinter(account: string): Promise<boolean> {
  return isPartsOwner(account)
}

/** 新手大礼包领取状态(合约内置 claim_starter_pack,无独立 claim 合约) */
export async function fetchStarterClaimState(address: string): Promise<boolean> {
  if (!isValidNearAddress(address)) return false
  return (await callView<boolean>('is_starter_claimed', { account_id: address })) ?? false
}

/** 领取新手大礼包:合约内随机选 4 件(每槽 1 件,源自各槽前 8 件)铸造并自动穿戴;
 *  与 EVM 侧一样每账户限一次,须已铸主身份。tokenId 参数忽略(合约按调用者查)。
 *  返回 NEAR tx hash。 */
export async function claimStarterPack(owner: string, _tokenId: number): Promise<string> {
  requireNearAccount(owner)
  const claimed = await fetchStarterClaimState(owner)
  if (claimed) throw new Error('该账户已领取过新手大礼包')
  return sendCall('claim_starter_pack', {}, '0')
}

// ---------------- 写入(全部经 wallet-selector 签广播,返回 NEAR tx hash) ----------------

/** 单笔 view → FunctionCall 交易;写操作前常会先读链校验(与 Solana 侧同思路) */
async function sendCall(methodName: string, args: Record<string, unknown>, deposit = '0'): Promise<string> {
  return nearSignAndSend([nearFunctionCall(methodName, args, '50000000000000', deposit)])
}

/**
 * 铸造 Agent 主身份。profileURI 参数忽略(NEAR 合约无此字段,bio 不上链),
 * 函数签名与 EVM/Solana 侧保持一致。
 * 铸造费:先查 get_current_fee,作为 attached deposit 原样传入(前 10 个为 "0")。
 */
export async function mintIdentity(owner: string, name: string, _profileURI: string): Promise<string> {
  requireNearAccount(owner)
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 64) throw new Error('名称不符合要求(1-64 字符)')
  const fee = await callView<string>('get_current_fee', {})
  if (fee === null) throw new Error('链上费率读取失败,请稍后重试')
  return sendCall('mint_identity', { name: trimmed }, fee)
}

/** 穿戴:先读 get_part 校验注册与槽位,再 equip(合约自动退旧装新) */
export async function equipPart(owner: string, tokenId: number, slot: number, partChainId: number): Promise<string> {
  requireNearAccount(owner)
  const part = await callView<PartView>('get_part', { part_id: u64(partChainId) })
  if (!part || !part.registered) throw new Error('该配件尚未注册,请先注册')
  if (part.slot !== slot) throw new Error('配件插槽与目标插槽不匹配')
  return sendCall('equip', { token_id: u64(tokenId), part_id: u64(partChainId), slot })
}

/** 卸下配件(先读 get_equipped 确认插槽非空,合约托管退回可用余额) */
export async function unequipPart(owner: string, tokenId: number, slot: number): Promise<string> {
  requireNearAccount(owner)
  const equipped = await callView<(string | null)[]>('get_equipped', { token_id: u64(tokenId) })
  if (!equipped || !equipped[slot]) throw new Error('该插槽没有装备中的配件')
  return sendCall('unequip', { token_id: u64(tokenId), slot })
}

/**
 * 人格上链(镜像模式,与 Solana 一致):uri 为 data:application/json base64,
 * 解出 JSON 原文 PUT 到 agent 服务 /personas/<0xhash>,再 update_persona(hash, '')
 * (空 arweave_id 合法,表示镜像模式;persona_hash 合约接受带 0x 前缀的 64 位 hex)。
 */
export async function setPersonaOnChain(
  owner: string,
  tokenId: number,
  uri: string,
  contentHash: `0x${string}`,
): Promise<string> {
  requireNearAccount(owner)
  const json = decodePersonaJson(uri)
  if (keccak256(toBytes(json)) !== contentHash.toLowerCase()) throw new Error('人格配置哈希校验失败')
  await putPersonaMirror(contentHash, json)
  return sendCall('update_persona', { token_id: u64(tokenId), persona_hash: contentHash, arweave_id: '' })
}

/** 单条注册配件(仅合约 owner) */
export async function registerPart(owner: string, chainId: number, slot: number, rarity: number, maxSupply: number): Promise<string> {
  requireNearAccount(owner)
  return sendCall('register_part', { part_id: u64(chainId), slot, rarity, max_supply: u64(maxSupply) })
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

/** 批量铸造:合约是单笔 mint_part(to, part_id, amount),这里按 id 循环发多笔,返回最后一笔 tx hash */
export async function mintPartsBatch(owner: string, to: string, ids: bigint[], amounts: bigint[]): Promise<string> {
  if (ids.length === 0 || amounts.length === 0 || ids.length !== amounts.length) {
    throw new Error('铸造参数不能为空且 ids 与 amounts 长度必须一致')
  }
  requireNearAccount(owner)
  if (!isValidNearAddress(to)) throw new Error('接收地址不是有效的 NEAR 账户 id')
  // 先批量校验注册状态,避免铸到一半才报错
  const views = await callViewBatch<PartView>(
    'get_part',
    ids.map((id) => ({ part_id: u64(id) })),
  )
  views.forEach((view, i) => {
    if (!view || !view.registered) throw new Error(`配件 #${Number(ids[i])} 尚未注册`)
  })
  let lastHash = ''
  for (let i = 0; i < ids.length; i++) {
    lastHash = await sendCall('mint_part', { to, part_id: u64(ids[i]), amount: u64(amounts[i]) })
  }
  return lastHash
}

// ---------------- 错误解释 ----------------

/** 把 NEAR 合约 panic / 钱包错误翻译成中文提示 */
export function explainNearChainError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // 合约 require!/panic_str 的消息原样在 Failure 里
  const table: Record<string, string> = {
    AlreadyHasDID: '该地址已铸造过 Agent(每地址限 1 枚)',
    InvalidName: '名称不符合要求(1-64 字符)',
    NameTaken: '该名称已被占用,请换一个',
    InsufficientFee: '铸造费不足:attached deposit 低于当前费率,请刷新页面后重试',
    InvalidPersonaHash: '人格哈希不合法(需 64 位 hex)',
    InvalidArweaveId: 'arweave id 不合法(空串或 43 位 base64url)',
    IdentityNotFound: '该 Agent 身份不存在',
    'not token owner': '只有 Agent 持有者本人可以操作',
    PartNotRegistered: '该配件尚未注册,请先注册',
    PartAlreadyRegistered: '该配件已注册,不能重复注册',
    InvalidMaxSupply: '最大供应量必须大于 0',
    PartNotMintable: '该配件已关闭铸造(mintable=false)',
    MaxSupplyExceeded: '铸造数量超过该配件最大供应量',
    'not minter': '当前地址没有铸造权限(需合约 owner 或授权 minter)',
    'not owner': '当前地址不是合约 owner',
    WrongSlot: '配件插槽与目标插槽不匹配',
    InvalidSlot: '插槽无效(0-3)',
    SlotEmpty: '该插槽没有装备中的配件',
    SlotsNotEmpty: '关闭身份前必须先卸下全部装备',
    NoIdentity: '尚未铸造 Agent 身份',
    TokenLocked: '身份处于 Soulbound 锁定状态,需先解锁',
    'exceeds allowance': '功能调用密钥额度不足,请在钱包中批准全额访问后重试',
  }
  for (const [key, text] of Object.entries(table)) {
    if (msg.includes(key)) return text
  }
  if (/reject|denied|declined|cancel|closed|dismiss/i.test(msg)) return '你取消了钱包操作'
  if (/NotEnoughBalance|insufficient/i.test(msg)) return '钱包 NEAR 余额不足(交易还需少量 gas),请先领取测试币'
  if (/timeout|timed out/i.test(msg)) return '交易确认超时,请重试(测试网拥堵时可能发生)'
  return `链上操作失败: ${msg.length > 120 ? msg.slice(0, 120) + '…' : msg}`
}
