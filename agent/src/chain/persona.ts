import { createPublicClient, http, keccak256, toBytes, type Address } from 'viem'
import { sepolia } from 'viem/chains'
import { config } from '../config'
import type { AIProfile } from '../types'

// ============================================================
// 链上人格装载:personaOf(tokenId) → data URI 解析 → keccak256 校验
// 校验不过宁可拒绝装载,防止链下人格数据被篡改(见设计文档 §4.3)
// ============================================================

// 只需要三个只读方法,ABI 内联即可,避免依赖整份合约 ABI 文件
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
] as const

const client = createPublicClient({
  chain: sepolia,
  transport: http(config.sepoliaRpc),
})

// 链上无人格时的兜底人格(与前端 web/src/store/appStore.ts 的 defaultAIProfile 一致)
export const defaultAIProfile: AIProfile = {
  template: '理性',
  personality: '话少毒舌,喜欢分享 Web3 知识,讨厌空话',
  tone: '短句干练',
  replySpeed: 'human',
  topics: ['NFT', 'AI'],
  blacklist: '',
  socialMode: 'greet',
  autoGreet: true,
  autoReply: true,
  memory: true,
  emergency: false,
}

export interface LoadedPersona {
  tokenId: number
  name: string // 链上 Agent 名称(nameOf),用于身份区分
  profile: AIProfile
  fromChain: boolean // false = 链上无人格,用的默认兜底
  contentHash: string
}

export class PersonaError extends Error {}

/** 地址 → tokenId;未铸造返回 0(合约约定) */
export async function resolveTokenId(owner: Address): Promise<number> {
  const tokenId = (await client.readContract({
    address: config.identityAddress,
    abi: identityAbi,
    functionName: 'tokenIdOf',
    args: [owner],
  })) as bigint
  return Number(tokenId)
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
export async function fetchPersonaFromChain(tokenId: number): Promise<LoadedPersona> {
  const [res, name] = await Promise.all([
    client.readContract({
      address: config.identityAddress,
      abi: identityAbi,
      functionName: 'personaOf',
      args: [BigInt(tokenId)],
      // viem 对命名 tuple 返回对象 { uri, contentHash },做兼容处理
    }) as Promise<{ uri: string; contentHash: `0x${string}` } | [string, `0x${string}`]>,
    client.readContract({
      address: config.identityAddress,
      abi: identityAbi,
      functionName: 'nameOf',
      args: [BigInt(tokenId)],
    }) as Promise<string>,
  ])
  const uri = Array.isArray(res) ? res[0] : res.uri
  const contentHash = (Array.isArray(res) ? res[1] : res.contentHash) ?? '0x'

  if (!uri) {
    return { tokenId, name, profile: defaultAIProfile, fromChain: false, contentHash }
  }
  const profile = decodePersonaUri(uri, contentHash)
  return { tokenId, name, profile, fromChain: true, contentHash }
}

// 人格缓存:每个 tokenId 只装载一次,reload 接口强制刷新
const personaCache = new Map<number, LoadedPersona>()

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
