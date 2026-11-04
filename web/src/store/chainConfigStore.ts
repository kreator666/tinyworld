import { create } from 'zustand'
import { CONTRACTS_BY_KEY, type ChainContracts, type ChainKey } from '../lib/contracts'

// ============================================================
// 激活链状态:导航栏按钮切换;合约地址以后端 GET /chains 为准,本地 CONTRACTS_BY_KEY 兜底
// 素材(角色/装备目录)与链无关,切换只影响读写的合约与 RPC
// ============================================================

interface ChainConfigState {
  active: ChainContracts
  chains: ChainContracts[]
  /** 测试网开关:关闭时链选择器只显示主网;默认关闭(localStorage 持久化) */
  showTestnets: boolean
  setShowTestnets: (show: boolean) => void
  setActive: (key: ChainKey) => void
  /** 启动时从 agent 服务拉 chains 表合并进本地兜底数据;服务不可达时静默保留本地 */
  hydrateFromApi: () => Promise<void>
}

const AGENT_API = (import.meta.env.VITE_AGENT_API as string | undefined) ?? ''
const SHOW_TESTNETS_KEY = 'tinyworld-show-testnets'
const ACTIVE_CHAIN_KEY = 'tinyworld-active-chain'

function loadShowTestnets(): boolean {
  try {
    return localStorage.getItem(SHOW_TESTNETS_KEY) === '1'
  } catch {
    return false
  }
}

/** 恢复上次激活的链(仅 mainnet 链或测试网开关打开时的任意链;非法值回退 Avalanche 主网) */
function loadActiveChain(showTestnets: boolean): ChainContracts {
  try {
    const key = localStorage.getItem(ACTIVE_CHAIN_KEY) as ChainKey | null
    const chain = key ? CONTRACTS_BY_KEY[key] : undefined
    if (chain && (showTestnets || !chain.testnet)) return chain
  } catch {
    // localStorage 不可用时用默认
  }
  return CONTRACTS_BY_KEY.avalanche
}

export const useChainConfig = create<ChainConfigState>((set, get) => ({
  // 默认激活 Avalanche 主网:生产环境已迁移至此,避免用户手动切链
  active: loadActiveChain(loadShowTestnets()),
  chains: Object.values(CONTRACTS_BY_KEY),
  showTestnets: loadShowTestnets(),

  setShowTestnets: (show) => {
    try {
      localStorage.setItem(SHOW_TESTNETS_KEY, show ? '1' : '0')
    } catch {
      // localStorage 不可用时仅会话内生效
    }
    set((s) => {
      // 关闭测试网时若当前激活链是测试网,自动切到第一个主网
      if (!show && s.active.testnet) {
        const mainnet = s.chains.find((c) => !c.testnet)
        if (mainnet) {
          try {
            localStorage.setItem(ACTIVE_CHAIN_KEY, mainnet.key)
          } catch {}
          return { showTestnets: show, active: mainnet }
        }
      }
      return { showTestnets: show }
    })
  },

  setActive: (key) => {
    const next = get().chains.find((c) => c.key === key)
    if (next) {
      try {
        localStorage.setItem(ACTIVE_CHAIN_KEY, key)
      } catch {}
      set({ active: next })
    }
  },

  hydrateFromApi: async () => {
    try {
      const res = await fetch(`${AGENT_API}/chains`)
      if (!res.ok) return
      const data = (await res.json()) as {
        chains: {
          chain_key: string
          chain_id: number
          name: string
          identity_address: string
          parts_address: string
          rpc: string
          explorer: string
          family?: string
          config?: { partsClaim?: string } & Record<string, unknown> // chains 表 JSONB:合约地址列之外的扩展配置
        }[]
      }
      const merged = get().chains.map((local) => {
        // 按 chain_id 匹配后端 chains 表,地址/RPC/浏览器/family 以后端为准(多链:后端是链目录的唯一权威)
        const remote = data.chains.find((r) => r.chain_id === local.chainId)
        if (!remote) return local
        return {
          ...local,
          name: remote.name as ChainContracts['name'],
          identity: remote.identity_address as `0x${string}`,
          parts: remote.parts_address as `0x${string}`,
          rpc: remote.rpc,
          explorer: remote.explorer,
          family: (remote.family as 'evm' | 'solana' | 'near' | undefined) ?? local.family,
          // 新手装备领养与市场合约地址走 chains.config JSONB;后端未配置时保留本地兜底
          partsClaim: (remote.config?.partsClaim as `0x${string}` | undefined) ?? local.partsClaim,
          market: ((remote.config?.market as { address?: `0x${string}` } | undefined)?.address) ?? local.market,
        }
      })
      set((s) => {
        // 测试网关闭时激活链不允许停留在测试网
        const active = merged.find((c) => c.key === s.active.key) ?? merged[0]
        const mainnet = merged.find((c) => !c.testnet)
        return {
          chains: merged,
          active: !s.showTestnets && active.testnet && mainnet ? mainnet : active,
        }
      })
    } catch {
      // agent 服务未启动:静默使用本地兜底数据
    }
  },
}))

/** 非 React 场景(chain.ts 等)读取当前激活链配置 */
export const getActiveChain = (): ChainContracts => useChainConfig.getState().active

// 浏览器链接生成(跟随当前激活链;Solana 需额外带 cluster 参数;NEAR 的 nearblocks 用 /txns 路径)
export const explorerTx = (hash: string) => {
  const c = getActiveChain()
  if (c.family === 'solana') return `${c.explorer}/tx/${hash}?cluster=testnet`
  if (c.family === 'near') return `${c.explorer}/txns/${hash}`
  return `${c.explorer}/tx/${hash}`
}
export const explorerAddress = (addr: string) => {
  const c = getActiveChain()
  if (c.family === 'solana') return `${c.explorer}/address/${addr}?cluster=testnet`
  return `${c.explorer}/address/${addr}`
}
