import { createPublicClient, formatEther, formatUnits, http, keccak256, toBytes, isAddress, type Address } from 'viem'
import { sepolia, avalancheFuji } from 'viem/chains'
import type { AIProfile } from '../types'
import * as solana from './personaSolana'
import { getChainContext } from './registry'
import {
  PERMISSION_SOCIAL,
  PersonaError,
  defaultAIProfile,
  personaCache,
  personaCacheKey,
  type AgentSummary,
  type EquipmentItem,
  type LoadedPersona,
  type WalletAssets,
} from './personaShared'

// 与 personaSolana 共用的类型/常量/缓存在 personaShared.ts 定义并从本模块原样 re-export,
// 保证两处导出完全相同的接口与 instanceof 语义
export {
  PERMISSION_SOCIAL,
  PersonaError,
  defaultAIProfile,
  personaCache,
  type AgentSummary,
  type EquipmentItem,
  type LoadedPersona,
  type WalletAssets,
}

// ============================================================
// 多链重构(方案A):本模块是 persona 的 EVM 家族实现 + Solana 家族分派层。
// 所有公开函数首参 chainKey;家族决定走 viem(本文件)还是委托 personaSolana。
// 链上下文(合约地址/RPC)经 registry 按 chainKey 解析,不再读全局 config.chain。
// ============================================================

function isSolana(chainKey: string): boolean {
  return getChainContext(chainKey).family === 'solana'
}

/** 地址格式校验:EVM 用 viem isAddress,Solana 用 base58 校验(链无关,按地址形态判断) */
export function isValidAddress(address: string): boolean {
  return isAddress(address as Address) || solana.isValidSolanaAddress(address)
}

// ============================================================
// 链上人格装载:personaOf(tokenId) → data URI 解析 → keccak256 校验
// 校验不过宁可拒绝装载,防止链下人格数据被篡改(见设计文档 §4.3)
// ============================================================

// 只需要只读方法,ABI 内联即可,避免依赖整份合约 ABI 文件
const identityAbi = [
  {
    type: 'function',
    name: 'tokenIdOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'nameOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'personaOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'uri', type: 'string' },
          { name: 'contentHash', type: 'bytes32' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'totalMinted',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'agentPermissions',
    stateMutability: 'view',
    inputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getEquipped',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        name: 'items',
        type: 'tuple[4]',
        components: [
          { name: 'collection', type: 'address' },
          { name: 'id', type: 'uint256' },
        ],
      },
    ],
  },
] as const

// DIDParts(ERC1155)只用到 balanceOf 查持有量
const partsAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// 按链缓存只读客户端(链定义只影响编码细节;合约地址随请求链变化)
const VIEM_CHAINS = { [sepolia.id]: sepolia, [avalancheFuji.id]: avalancheFuji } as const
const clients = new Map<string, ReturnType<typeof createPublicClient>>()

function clientFor(chainKey: string): ReturnType<typeof createPublicClient> {
  let client = clients.get(chainKey)
  if (!client) {
    const { cfg } = getChainContext(chainKey)
    client = createPublicClient({
      chain: VIEM_CHAINS[cfg.chainId as keyof typeof VIEM_CHAINS] ?? sepolia,
      transport: http(cfg.rpc),
    })
    clients.set(chainKey, client)
  }
  return client
}

/** 地址 → tokenId;未铸造返回 0(合约约定) */
export async function resolveTokenId(chainKey: string, owner: string): Promise<number> {
  if (isSolana(chainKey)) return solana.resolveTokenId(chainKey, owner)
  const tokenId = (await clientFor(chainKey).readContract({
    address: getChainContext(chainKey).cfg.identityAddress as Address,
    abi: identityAbi,
    functionName: 'tokenIdOf',
    args: [owner as Address],
  })) as bigint
  return Number(tokenId)
}

/** tokenId → owner 地址 */
export async function ownerOf(chainKey: string, tokenId: number): Promise<string> {
  if (isSolana(chainKey)) return solana.ownerOf(chainKey, tokenId)
  return (await clientFor(chainKey).readContract({
    address: getChainContext(chainKey).cfg.identityAddress as Address,
    abi: identityAbi,
    functionName: 'ownerOf',
    args: [BigInt(tokenId)],
  })) as Address
}

/** 解析 data:application/json;base64,<...> 为 JSON 文本,并校验 keccak256 */
function decodePersonaUri(uri: string, contentHash: string): AIProfile {
  const prefix = 'data:application/json;base64,'
  if (!uri.startsWith(prefix)) {
    throw new PersonaError('人格 URI 不是 data:application/json;base64 格式,拒绝装载')
  }
  const json = Buffer.from(uri.slice(prefix.length), 'base64').toString('utf-8')
  // 哈希按 JSON 原始字节计算,与前端 setPersona 写链时的 keccak256(toBytes(json)) 一致
  const actual = keccak256(toBytes(json))
  if (actual.toLowerCase() !== contentHash.toLowerCase()) {
    throw new PersonaError(`人格内容哈希不匹配(链上 ${contentHash},实际 ${actual}),拒绝装载`)
  }
  let raw: Partial<AIProfile>
  try {
    raw = JSON.parse(json)
  } catch {
    throw new PersonaError('人格 JSON 解析失败,拒绝装载')
  }
  // 字段缺失时用默认值补齐,容忍链上旧版本人格
  return { ...defaultAIProfile, ...raw }
}

/** 从链上读取并校验人格(uri 为空则返回默认人格兜底);同时读链上名称用于身份区分 */
export async function fetchPersonaFromChain(chainKey: string, tokenId: number): Promise<LoadedPersona> {
  if (isSolana(chainKey)) return solana.fetchPersonaFromChain(chainKey, tokenId)
  const client = clientFor(chainKey)
  const identityAddress = getChainContext(chainKey).cfg.identityAddress as Address
  const [res, name, owner] = await Promise.all([
    client.readContract({
      address: identityAddress,
      abi: identityAbi,
      functionName: 'personaOf',
      args: [BigInt(tokenId)],
      // viem 对命名 tuple 返回对象 { uri, contentHash },做兼容处理
    }) as Promise<{ uri: string; contentHash: `0x${string}` } | [string, `0x${string}`]>,
    client.readContract({
      address: identityAddress,
      abi: identityAbi,
      functionName: 'nameOf',
      args: [BigInt(tokenId)],
    }) as Promise<string>,
    client.readContract({
      address: identityAddress,
      abi: identityAbi,
      functionName: 'ownerOf',
      args: [BigInt(tokenId)],
    }) as Promise<Address>,
  ])
  const uri = Array.isArray(res) ? res[0] : res.uri
  const contentHash = (Array.isArray(res) ? res[1] : res.contentHash) ?? '0x'

  if (!uri) {
    return { tokenId, name, owner, profile: defaultAIProfile, fromChain: false, contentHash }
  }
  const profile = decodePersonaUri(uri, contentHash)
  return { tokenId, name, owner, profile, fromChain: true, contentHash }
}

export async function loadPersona(chainKey: string, tokenId: number, force = false): Promise<LoadedPersona> {
  if (isSolana(chainKey)) return solana.loadPersona(chainKey, tokenId, force)
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

/** 链上 agentPermissions[tokenId][agentAddr] 位掩码(安装需要权限的技能前校验) */
export async function getAgentPermissions(chainKey: string, tokenId: number, agentAddr: string): Promise<bigint> {
  if (isSolana(chainKey)) return solana.getAgentPermissions(chainKey, tokenId, agentAddr)
  return (await clientFor(chainKey).readContract({
    address: getChainContext(chainKey).cfg.identityAddress as Address,
    abi: identityAbi,
    functionName: 'agentPermissions',
    args: [BigInt(tokenId), agentAddr as Address],
  })) as bigint
}

/** 列出全部已铸造的 Agent(心跳调度器每轮枚举用) */
export async function listMintedAgents(chainKey: string): Promise<AgentSummary[]> {
  if (isSolana(chainKey)) return solana.listMintedAgents(chainKey)
  const client = clientFor(chainKey)
  const identityAddress = getChainContext(chainKey).cfg.identityAddress as Address
  const total = Number(
    (await client.readContract({
      address: identityAddress,
      abi: identityAbi,
      functionName: 'totalMinted',
    })) as bigint,
  )
  const tokenIds: number[] = []
  for (let i = 1; i <= total; i++) tokenIds.push(i)
  return Promise.all(
    tokenIds.map(async (tokenId) => {
      const [name, owner] = await Promise.all([
        client.readContract({
          address: identityAddress,
          abi: identityAbi,
          functionName: 'nameOf',
          args: [BigInt(tokenId)],
        }) as Promise<string>,
        client.readContract({
          address: identityAddress,
          abi: identityAbi,
          functionName: 'ownerOf',
          args: [BigInt(tokenId)],
        }) as Promise<Address>,
      ])
      return { tokenId, name, owner, bio: '' }
    }),
  )
}

/** 列出最新铸造的 N 个 Agent(social-greeter 的 list_new_agents 用) */
export async function listRecentAgents(chainKey: string, limit = 5): Promise<AgentSummary[]> {
  if (isSolana(chainKey)) return solana.listRecentAgents(chainKey, limit)
  const client = clientFor(chainKey)
  const identityAddress = getChainContext(chainKey).cfg.identityAddress as Address
  const total = Number(
    (await client.readContract({
      address: identityAddress,
      abi: identityAbi,
      functionName: 'totalMinted',
    })) as bigint,
  )
  const from = Math.max(1, total - limit + 1)
  const tokenIds: number[] = []
  for (let i = total; i >= from; i--) tokenIds.push(i)
  return Promise.all(
    tokenIds.map(async (tokenId) => {
      const [name, owner] = await Promise.all([
        client.readContract({
          address: identityAddress,
          abi: identityAbi,
          functionName: 'nameOf',
          args: [BigInt(tokenId)],
        }) as Promise<string>,
        client.readContract({
          address: identityAddress,
          abi: identityAbi,
          functionName: 'ownerOf',
          args: [BigInt(tokenId)],
        }) as Promise<Address>,
      ])
      return { tokenId, name, owner, bio: '' }
    }),
  )
}

/** 读链上装备(getEquipped)并按 DIDParts balanceOf 概述持有(defi-quote 的 get_my_equipment 用) */
export async function getEquipment(chainKey: string, tokenId: number): Promise<EquipmentItem[]> {
  if (isSolana(chainKey)) return solana.getEquipment(chainKey, tokenId)
  const client = clientFor(chainKey)
  const { identityAddress, partsAddress } = getChainContext(chainKey).cfg
  const [items, owner] = await Promise.all([
    client.readContract({
      address: identityAddress as Address,
      abi: identityAbi,
      functionName: 'getEquipped',
      args: [BigInt(tokenId)],
    }) as Promise<readonly { collection: Address; id: bigint }[]>,
    client.readContract({
      address: identityAddress as Address,
      abi: identityAbi,
      functionName: 'ownerOf',
      args: [BigInt(tokenId)],
    }) as Promise<Address>,
  ])
  const result: EquipmentItem[] = []
  for (let slot = 0; slot < items.length; slot++) {
    const { collection, id } = items[slot]
    if (id === 0n) continue // 空槽位
    const balance = (await client.readContract({
      address: partsAddress as Address,
      abi: partsAbi,
      functionName: 'balanceOf',
      args: [owner, id],
    })) as bigint
    result.push({ slot, collection, partId: Number(id), balance: Number(balance) })
  }
  return result
}

// ============================================================
// 钱包资产查询(get_wallet_assets 工具用):原生币 + USDC + DID 装备
// ============================================================

const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export async function getWalletAssets(chainKey: string, address: string, tokenId: number): Promise<WalletAssets> {
  if (isSolana(chainKey)) return solana.getWalletAssets(chainKey, address, tokenId)
  const { usdc, usdt, nativeSymbol } = getChainContext(chainKey).cfg.defi! // 仅 EVM 家族链会走到这里(defi 必填)
  const client = clientFor(chainKey)
  const addr = address as Address
  const balanceOf = (token: `0x${string}`) =>
    token === ZERO_ADDRESS
      ? Promise.resolve(0n) // 该链无此代币配置
      : (client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [addr],
        }) as Promise<bigint>)
  const [nativeBal, usdcBal, usdtBal, equipment] = await Promise.all([
    client.getBalance({ address: addr }),
    balanceOf(usdc),
    balanceOf(usdt),
    getEquipment(chainKey, tokenId),
  ])
  return {
    address,
    nativeBalance: formatEther(nativeBal),
    nativeSymbol,
    usdcBalance: formatUnits(usdcBal, 6),
    usdtBalance: formatUnits(usdtBal, 6),
    equipment,
  }
}
