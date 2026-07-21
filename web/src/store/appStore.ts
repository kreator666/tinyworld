import { create } from 'zustand'
import type { AIProfile, ChatSession, DIDIdentity, Equipped, NFTCategory, NFTItem } from '../types'
import { aiReplies, initialChats, nftLibrary } from '../mock/data'

export const emptyEquipped: Equipped = { head: null, skin: null, outfit: null, accessory: null }

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
  connect: (provider: string) => void
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
  ensureChatWith: (peerName: string, peerAddress: string, peerEmoji: string, mode: 'human' | 'ai', aiTag: string) => string
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
  connect: (provider) =>
    set({ connected: true, provider, address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063' }),
  disconnect: () => set({ connected: false, provider: null, address: null }),

  did: null,
  mintDID: (name, bio, chain, equipped) =>
    set({
      did: {
        name, bio, chain,
        mintedAt: new Date().toISOString().slice(0, 10),
        contract: '0xDIDaiVerse...' + Math.random().toString(16).slice(2, 8),
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

  chats: initialChats,
  activeChatId: initialChats[0]?.id ?? null,
  setActiveChat: (id) => set({ activeChatId: id }),
  switchChatMode: (id, mode) =>
    set((s) => ({ chats: s.chats.map((c) => (c.id === id ? { ...c, mode } : c)) })),
  sendMessage: (sessionId, text, kind = 'text', nftId) => {
    const msg = { id: `m${msgSeq++}`, from: 'me' as const, kind, text, nftId, time: now() }
    set((s) => ({
      chats: s.chats.map((c) => (c.id === sessionId ? { ...c, messages: [...c.messages, msg] } : c)),
    }))
    // 模拟对方 AI 分身延迟回复
    const session = get().chats.find((c) => c.id === sessionId)
    if (session && (session.mode === 'ai' || !session.online)) {
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
  ensureChatWith: (peerName, peerAddress, peerEmoji, mode, aiTag) => {
    const existing = get().chats.find((c) => c.peerName === peerName)
    if (existing) {
      set({ activeChatId: existing.id })
      return existing.id
    }
    const id = `c${Date.now()}`
    const session: ChatSession = {
      id, peerName, peerAddress, peerEmoji, mode, aiTag, online: mode === 'human',
      messages: [{
        id: `m${msgSeq++}`, from: 'peer', kind: 'text',
        text: mode === 'ai' ? `你好,我是 ${peerName} 的 AI 分身,本人离线时由我代为交流~` : `你好,我是 ${peerName}。`,
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
