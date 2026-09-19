import { create } from 'zustand'
import type { AIProfile, ChatSession, DIDIdentity, Equipped, NFTCategory, NFTItem, WalletLogin } from '../types'
import { aiReplies, nftLibrary } from '../mock/data'

export const emptyEquipped: Equipped = { head: null, body: null, accessory: null, pet: null }

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

interface AppState {
  // 钱包
  connected: boolean
  address: string | null
  provider: string | null
  login: WalletLogin | null
  connect: (login: WalletLogin) => void
  disconnect: () => void
  // DID 身份
  did: DIDIdentity | null
  mintDID: (name: string, bio: string, chain: DIDIdentity['chain'], equipped: Equipped) => void
  // 背包(持有的 NFT)
  inventory: NFTItem[]
  addToInventory: (items: NFTItem[]) => void
  equip: (category: NFTCategory, itemId: string) => void
  // AI 分身配置
  aiProfile: AIProfile
  saveAIProfile: (p: AIProfile) => void
  resetAIProfile: () => void
  // 社交
  following: string[]
  favorites: string[]
  toggleFollow: (id: string) => void
  toggleFavorite: (id: string) => void
  // 聊天
  chats: ChatSession[]
  activeChatId: string | null
  setActiveChat: (id: string) => void
  switchChatMode: (id: string, mode: 'human' | 'ai') => void
  sendMessage: (sessionId: string, text: string, kind?: 'text' | 'nft', nftId?: string) => void
  appendPeerMessage: (sessionId: string, text: string) => void
  upsertChainSession: (agent: { tokenId: number; name: string; owner: string }, selfAgent: boolean) => string
  ensureChatWith: (peerName: string, peerAddress: string, peerEmoji: string, mode: 'human' | 'ai', aiTag: string, opts?: { selfAgent?: boolean; agentTokenId?: number }) => string
  // 全局提示
  toast: string | null
  showToast: (msg: string) => void
}

const now = () => new Date().toTimeString().slice(0, 5)
let msgSeq = 100

export const useAppStore = create<AppState>((set, get) => ({
  connected: false,
  address: null,
  provider: null,
  login: null,
  connect: (login) =>
    set({ connected: true, provider: login.provider, address: login.address, login }),
  disconnect: () => set({ connected: false, provider: null, address: null, login: null }),

  did: null,
  mintDID: (name, bio, chain, equipped) =>
    set({
      did: {
        name, bio, chain,
        mintedAt: new Date().toISOString().slice(0, 10),
        contract: 'AgentVerse Identity...' + Math.random().toString(16).slice(2, 8),
        address: get().address ?? '0x0',
        equipped,
      },
    }),

  inventory: nftLibrary.filter((i) => i.owned),
  addToInventory: (items) =>
    set((s) => {
      const ids = new Set(s.inventory.map((i) => i.id))
      return { inventory: [...s.inventory, ...items.filter((i) => !ids.has(i.id)).map((i) => ({ ...i, owned: true }))] }
    }),
  equip: (category, itemId) =>
    set((s) => (s.did ? { did: { ...s.did, equipped: { ...s.did.equipped, [category]: itemId } } } : s)),

  aiProfile: defaultAIProfile,
  saveAIProfile: (p) => set({ aiProfile: p }),
  resetAIProfile: () => set({ aiProfile: defaultAIProfile }),

  following: [],
  favorites: [],
  toggleFollow: (id) =>
    set((s) => ({ following: s.following.includes(id) ? s.following.filter((f) => f !== id) : [...s.following, id] })),
  toggleFavorite: (id) =>
    set((s) => ({ favorites: s.favorites.includes(id) ? s.favorites.filter((f) => f !== id) : [...s.favorites, id] })),

  chats: [],
  activeChatId: null,
  setActiveChat: (id) => set({ activeChatId: id }),
  switchChatMode: (id, mode) =>
    set((s) => ({ chats: s.chats.map((c) => (c.id === id ? { ...c, mode } : c)) })),
  // 会话列表从链上读取:为每个已铸造的 Agent 建会话
  // 同名(链上名称唯一)的已有会话(如从个人主页"和 Agent 聊"创建)做合并,避免重复
  upsertChainSession: (agent, selfAgent) => {
    const id = `chain-${agent.tokenId}`
    const existing =
      get().chats.find((c) => c.id === id) ?? get().chats.find((c) => c.peerName === agent.name)
    if (existing) {
      set((s) => ({
        chats: s.chats.map((c) =>
          c.id === existing.id
            ? { ...c, agentTokenId: agent.tokenId, selfAgent: selfAgent || c.selfAgent }
            : c,
        ),
      }))
      return existing.id
    }
    const session: ChatSession = {
      id,
      peerName: agent.name,
      peerAddress: agent.owner.slice(0, 6) + '...' + agent.owner.slice(-4),
      peerEmoji: '🤖',
      mode: 'ai',
      aiTag: '链上 Agent',
      online: false,
      selfAgent,
      agentTokenId: agent.tokenId,
      messages: [],
    }
    set((s) => ({ chats: [...s.chats, session], activeChatId: s.activeChatId ?? id }))
    return id
  },
  sendMessage: (sessionId, text, kind = 'text', nftId) => {
    const msg = { id: `m${msgSeq++}`, from: 'me' as const, kind, text, nftId, time: now() }
    set((s) => ({
      chats: s.chats.map((c) => (c.id === sessionId ? { ...c, messages: [...c.messages, msg] } : c)),
    }))
    // 模拟对方 AI 分身延迟回复;链上 Agent 会话走真实 agent/ 服务,跳过 mock
    const session = get().chats.find((c) => c.id === sessionId)
    if (session && !session.selfAgent && session.agentTokenId == null && (session.mode === 'ai' || !session.online)) {
      const delay = 1000 + Math.random() * 2000
      setTimeout(() => {
        const reply = {
          id: `m${msgSeq++}`, from: 'peer' as const, kind: 'text' as const,
          text: aiReplies[Math.floor(Math.random() * aiReplies.length)],
          time: now(), ai: true,
        }
        set((s) => ({
          chats: s.chats.map((c) => (c.id === sessionId ? { ...c, messages: [...c.messages, reply] } : c)),
        }))
      }, delay)
    }
  },
  // 追加一条对方消息(selfAgent 会话的真实 Agent 回复用)
  appendPeerMessage: (sessionId, text) => {
    const msg = { id: `m${msgSeq++}`, from: 'peer' as const, kind: 'text' as const, text, time: now(), ai: true }
    set((s) => ({
      chats: s.chats.map((c) => (c.id === sessionId ? { ...c, messages: [...c.messages, msg] } : c)),
    }))
  },
  ensureChatWith: (peerName, peerAddress, peerEmoji, mode, aiTag, opts) => {
    const existing = get().chats.find((c) => c.peerName === peerName)
    if (existing) {
      // 已存在的会话补标记(比如先建了普通会话,再从主页"和 Agent 聊"进入)
      const patch: Partial<ChatSession> = {}
      if (opts?.selfAgent && !existing.selfAgent) patch.selfAgent = true
      if (opts?.agentTokenId != null && existing.agentTokenId == null) patch.agentTokenId = opts.agentTokenId
      if (Object.keys(patch).length > 0) {
        set((s) => ({ chats: s.chats.map((c) => (c.id === existing.id ? { ...c, ...patch } : c)) }))
      }
      set({ activeChatId: existing.id })
      return existing.id
    }
    const id = `c${Date.now()}`
    const session: ChatSession = {
      id, peerName, peerAddress, peerEmoji, mode, aiTag, online: mode === 'human',
      selfAgent: opts?.selfAgent, agentTokenId: opts?.agentTokenId,
      messages: [{
        id: `m${msgSeq++}`, from: 'peer', kind: 'text',
        text: mode === 'ai' ? `你好,我是 ${peerName} 的 Agent,本人离线时由我代为交流~` : `你好,我是 ${peerName}。`,
        time: now(), ai: mode === 'ai',
      }],
    }
    set((s) => ({ chats: [session, ...s.chats], activeChatId: id }))
    return id
  },

  toast: null,
  showToast: (msg) => {
    set({ toast: msg })
    setTimeout(() => set({ toast: null }), 2600)
  },
}))
