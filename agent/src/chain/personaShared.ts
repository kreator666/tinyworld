import { keccak256, toBytes } from 'viem'
import type { AIProfile } from '../types'

// ============================================================
// EVM(persona.ts)与 Solana(personaSolana.ts)共用的类型、常量与缓存。
// 两边导出完全相同的公开接口;此处只放与链无关的部分。
// ============================================================

// 权限位(与合约 DIDIdentity / Solana AgentPermission 的 PERMISSION_* 常量一致:bit1=social)
export const PERMISSION_SOCIAL = 2n

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
  name: string // 链上 Agent 名称(nameOf / Identity.name),用于身份区分
  owner: string // 主人钱包地址(ownerOf / Identity.owner),回答「我的资产」类问题时直接用
  profile: AIProfile
  fromChain: boolean // false = 链上无人格,用的默认兜底
  contentHash: string
}

export class PersonaError extends Error {}

export interface AgentSummary {
  tokenId: number
  name: string
  owner: string
  bio: string // EVM 合约无 bio 字段,固定 '';Solana 同样填 ''(形状对齐)
}

export interface EquipmentItem {
  slot: number // getEquipped / Identity.equipped 的固定 4 槽位下标
  collection: string
  partId: number
  balance: number // 主人在 DIDParts / Token-2022 账户里持有该部件的数量
}

export interface WalletAssets {
  address: string
  nativeBalance: string // 已换算成可读单位,如 '0.495'
  nativeSymbol: string
  usdcBalance: string // 已换算(6 位小数)
  usdtBalance: string // 已换算(6 位小数);该链未配置 USDT 时为 '0'
  equipment: EquipmentItem[]
}

// 人格 data URI 前缀(EVM 链上存整段 URI;web 重组后存镜像, Solana 侧读镜像时同样要剥)
export const DATA_PREFIX = 'data:application/json;base64,'

/** 剥掉 data URI 前缀取 JSON 原文(无前缀则原样返回) */
export function stripDataPrefix(text: string): string {
  return text.startsWith(DATA_PREFIX)
    ? Buffer.from(text.slice(DATA_PREFIX.length), 'base64').toString('utf-8')
    : text
}

/** 校验 JSON 原文的 keccak256 与链上 contentHash 一致,并解析为 AIProfile(缺失字段用默认补齐) */
export function parseVerifiedPersona(json: string, contentHash: string): AIProfile {
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

// 人格缓存:每个 (链, tokenId) 只装载一次,reload 接口强制刷新(EVM/Solana 共用语义)。
// 多链重构:tokenId 跨链可碰撞,u64 空间与 EVM 自增段重叠,key 必须带链维度。
export const personaCache = new Map<string, LoadedPersona>()

/** 人格缓存键:`${chainKey}:${tokenId}` */
export function personaCacheKey(chainKey: string, tokenId: number): string {
  return `${chainKey}:${tokenId}`
}
