import { create } from 'zustand'
import type { Address, Hash } from 'viem'
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
} from '../lib/chain'

// 链上状态(Sepolia):DID 主身份 + 配件资产 + 管理员发行;与本地 mock store 分离
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
  refresh: (address: Address) => Promise<void>
  mint: (address: Address, name: string, bio: string) => Promise<`0x${string}`>
  equip: (address: Address, slot: number, partChainId: number) => Promise<`0x${string}`>
  unequip: (address: Address, slot: number) => Promise<`0x${string}`>
  checkAdmin: (address: Address) => Promise<boolean>
  refreshPartStates: () => Promise<void>
  registerParts: (
    address: Address,
    parts: { chainId: number; slot: number; rarity: number; maxSupply: number; name: string }[],
    onProgress?: (p: RegisterProgress) => void,
  ) => Promise<Hash[]>
  mintParts: (address: Address, to: Address, ids: bigint[], amounts: bigint[]) => Promise<Hash>
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
    if (get().tokenId === 0) throw new Error('尚未铸造 DID 身份')
    try {
      const hash = await equipPart(address, get().tokenId, slot, partChainId)
      await get().refresh(address)
      return hash
    } catch (err) {
      throw new Error(explainChainError(err))
    }
  },

  unequip: async (address, slot) => {
    if (get().tokenId === 0) throw new Error('尚未铸造 DID 身份')
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
      const hash = await mintPartsBatch(address, to, ids, amounts)
      return hash
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
