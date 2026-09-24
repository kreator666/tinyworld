import { create } from 'zustand'
import { CONTRACTS_BY_KEY, type ChainContracts, type ChainKey } from '../lib/contracts'

// ============================================================
// 激活链状态:导航栏按钮切换;合约地址以后端 GET /chains 为准,本地 CONTRACTS_BY_KEY 兜底
// 素材(角色/装备目录)与链无关,切换只影响读写的合约与 RPC
// ============================================================

interface ChainConfigState {
  active: ChainContracts
  chains: ChainContracts[]
  setActive: (key: ChainKey) => void
  /** 启动时从 agent 服务拉 chains 表合并进本地兜底数据;服务不可达时静默保留本地 */
  hydrateFromApi: () => Promise<void>
}

const AGENT_API = (import.meta.env.VITE_AGENT_API as string | undefined) ?? ''

export const useChainConfig = create<ChainConfigState>((set, get) => ({
  active: CONTRACTS_BY_KEY.sepolia,
  chains: Object.values(CONTRACTS_BY_KEY),

  setActive: (key) => {
    const next = get().chains.find((c) => c.key === key)
    if (next) set({ active: next })
  },

  hydrateFromApi: async () => {
    try {
      const res = await fetch(`${AGENT_API}/chains`)
      if (!res.ok) return
      const data = (await res.json()) as {
        chains: { chain_key: string; chain_id: number; name: string; identity_address: string; parts_address: string; rpc: string; explorer: string }[]
      }
      const merged = get().chains.map((local) => {
        // 按 chain_id 匹配后端 chains 表,地址/RPC/浏览器以后端为准
        const remote = data.chains.find((r) => r.chain_id === local.chainId)
        if (!remote) return local
        return {
          ...local,
          name: remote.name as ChainContracts['name'],
          identity: remote.identity_address as `0x${string}`,
          parts: remote.parts_address as `0x${string}`,
          rpc: remote.rpc,
          explorer: remote.explorer,
        }
      })
      set((s) => ({
        chains: merged,
        active: merged.find((c) => c.key === s.active.key) ?? merged[0],
      }))
    } catch {
      // agent 服务未启动:静默使用本地兜底数据
    }
  },
}))

/** 非 React 场景(chain.ts 等)读取当前激活链配置 */
export const getActiveChain = (): ChainContracts => useChainConfig.getState().active

// 浏览器链接生成(跟随当前激活链)
export const explorerTx = (hash: string) => `${getActiveChain().explorer}/tx/${hash}`
export const explorerAddress = (addr: string) => `${getActiveChain().explorer}/address/${addr}`
