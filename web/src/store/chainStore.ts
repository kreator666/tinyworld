import { create } from 'zustand'
import type { Equipped } from '../types'
import { emptyEquipped } from './appStore'
import {
  equipPart,
  explainChainError,
  fetchChainState,
  fetchPartStates,
  isPartsMinter,
  isPartsOwner,
  mintIdentity,
  mintPartsBatch,
  registerPartsBatch,
  unequipPart,
  type ChainPartAsset,
  type ChainPartState,
  type RegisterProgress,
} from '../lib/chainDispatch'

// 链上状态(激活链,EVM/Solana 由 chainDispatch 按链族分发):DID 主身份 + 配件资产 + 管理员发行;与本地 mock store 分离
// 写操作返回值统一为 string(EVM 0x hash / Solana base58 signature)
interface ChainState {
  tokenId: number // 0 = 未铸造
  didName: string
  equipped: Equipped
  parts: ChainPartAsset[]
  loading: boolean
  error: string | null
  // 管理员
  isAdmin: boolean
  adminLoading: boolean
  partStates: ChainPartState[]
  refresh: (address: string) => Promise<void>
  mint: (address: string, name: string, bio: string) => Promise<string>
  equip: (address: string, slot: number, partChainId: number) => Promise<string>
  unequip: (address: string, slot: number) => Promise<string>
  checkAdmin: (address: string) => Promise<boolean>
  refreshPartStates: () => Promise<void>
  registerParts: (
    address: string,
    parts: { chainId: number; slot: number; rarity: number; maxSupply: number; name: string }[],
    onProgress?: (p: RegisterProgress) => void,
  ) => Promise<string[]>
  mintParts: (address: string, to: string, ids: bigint[], amounts: bigint[]) => Promise<string>
  clear: () => void
}

export const useChainStore = create<ChainState>((set, get) => ({
  tokenId: 0,
  didName: '',
  equipped: emptyEquipped,
  parts: [],
  loading: false,
  error: null,
  isAdmin: false,
  adminLoading: false,
  partStates: [],

  refresh: async (address) => {
    set({ loading: true, error: null })
    try {
      const s = await fetchChainState(address)
      set({ tokenId: s.tokenId, didName: s.didName, equipped: s.equipped, parts: s.parts, loading: false })
    } catch (err) {
      set({ loading: false, error: explainChainError(err) })
    }
  },

  mint: async (address, name, bio) => {
    try {
      const hash = await mintIdentity(address, name, bio)
      await get().refresh(address)
      return hash
    } catch (err) {
      throw new Error(explainChainError(err))
    }
  },

  equip: async (address, slot, partChainId) => {
    if (get().tokenId === 0) throw new Error('尚未铸造 Agent 身份')
    try {
      const hash = await equipPart(address, get().tokenId, slot, partChainId)
      await get().refresh(address)
      return hash
    } catch (err) {
      throw new Error(explainChainError(err))
    }
  },

  unequip: async (address, slot) => {
    if (get().tokenId === 0) throw new Error('尚未铸造 Agent 身份')
    try {
      const hash = await unequipPart(address, get().tokenId, slot)
      await get().refresh(address)
      return hash
    } catch (err) {
      throw new Error(explainChainError(err))
    }
  },

  checkAdmin: async (address) => {
    try {
      const [owner, minter] = await Promise.all([isPartsOwner(address), isPartsMinter(address)])
      const ok = owner || minter
      set({ isAdmin: ok })
      return ok
    } catch {
      set({ isAdmin: false })
      return false
    }
  },

  refreshPartStates: async () => {
    set({ adminLoading: true })
    try {
      const states = await fetchPartStates()
      set({ partStates: states, adminLoading: false })
    } catch (err) {
      set({ adminLoading: false, error: explainChainError(err) })
    }
  },

  registerParts: async (address, parts, onProgress) => {
    try {
      const hashes = await registerPartsBatch(address, parts, onProgress)
      await get().refreshPartStates()
      return hashes
    } catch (err) {
      throw new Error(explainChainError(err))
    }
  },

  mintParts: async (address, to, ids, amounts) => {
    try {
      return await mintPartsBatch(address, to, ids, amounts)
    } catch (err) {
      throw new Error(explainChainError(err))
    }
  },

  clear: () =>
    set({
      tokenId: 0,
      didName: '',
      equipped: emptyEquipped,
      parts: [],
      loading: false,
      error: null,
      isAdmin: false,
      adminLoading: false,
      partStates: [],
    }),
}))
