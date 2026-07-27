// 全局类型定义
export type Rarity = '普通' | '稀有' | '史诗' | '传说'
// 纸娃娃 4 插槽:头部 / 身体 / 配饰 / 宠物(渲染层级 pet→body→accessory→head)
export type NFTCategory = 'head' | 'body' | 'accessory' | 'pet'
export type ChainType = 'Polygon' | 'BSC' | 'ETH'

export interface WalletLogin {
  address: string
  signature: string
  chainId: number
  nonce: string
  timestamp: number
  provider: string
}

export interface NFTItem {
  id: string
  name: string
  category: NFTCategory
  rarity: Rarity
  price: number // 铸造单价 (ETH)
  emoji: string // 纸娃娃上的展示符号
  gradient: string // 展示用渐变
  owned: boolean
  hash: string // 链上哈希
  chain: ChainType
  count?: number // 持有数量
}

export type Equipped = Record<NFTCategory, string | null>

export interface DIDIdentity {
  name: string
  bio: string
  chain: ChainType
  mintedAt: string
  contract: string
  address: string
  equipped: Equipped
}

export interface AIProfile {
  template: string // 人设模板
  personality: string // 自定义性格
  tone: string // 语气风格
  replySpeed: 'instant' | 'human' // 回复速度
  topics: string[] // 聊天偏好
  blacklist: string // 规避话题
  socialMode: 'greet' | 'share' | 'passive' // 社交行为
  autoGreet: boolean // 自动接待访客
  autoReply: boolean // 自动回复私信
  memory: boolean // 记忆功能
  emergency: boolean // 紧急接管
}

export interface Message {
  id: string
  from: 'me' | 'peer'
  kind: 'text' | 'nft'
  text: string
  nftId?: string
  time: string
  ai?: boolean // 是否 AI 分身发送
}

export interface ChatSession {
  id: string
  peerName: string
  peerAddress: string
  peerEmoji: string
  mode: 'human' | 'ai' // 当前聊天对象:真人 / AI 分身
  online: boolean
  aiTag: string
  messages: Message[]
}

export interface PlazaUser {
  id: string
  name: string
  address: string
  emoji: string
  gradient: string
  aiTag: string
  activity: number // 活跃度
  rarest: Rarity
  mintedAt: string
  bio: string
}
