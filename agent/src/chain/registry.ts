import { config, ALL_CHAINS, type ChainConfig } from '../config'

// ============================================================
// 链注册表(多链重构·方案A):请求级链分派的核心。
// 单进程同时服务多链:每条链一个 ChainContext,链家族(evm/solana)决定实现分派。
// 链身份来源优先级:X-Chain-Key 请求头 → 默认链(TARGET_CHAIN,向后兼容)。
// ============================================================

export interface ChainContext {
  chainKey: string // chains 表主键,如 'solana-testnet' / 'fuji'
  family: 'evm' | 'solana'
  cfg: ChainConfig
}

const registry = new Map<string, ChainContext>()

for (const [chainKey, cfg] of Object.entries(ALL_CHAINS)) {
  registry.set(chainKey, { chainKey, family: cfg.family, cfg })
}

/** 已知链(ALL_CHAINS 的键) */
export function knownChainKeys(): string[] {
  return [...registry.keys()]
}

export function isKnownChainKey(chainKey: string): boolean {
  return registry.has(chainKey)
}

export function getChainContext(chainKey: string): ChainContext {
  const ctx = registry.get(chainKey)
  if (!ctx) throw new Error(`未知链: ${chainKey}(可选: ${knownChainKeys().join('/')})`)
  return ctx
}

/** 默认链 = TARGET_CHAIN(迁移基线,也是不带 X-Chain-Key 请求的回落链) */
export const defaultChainKey = config.chainKey

/** 从请求解析链:chainKey 入参为 X-Chain-Key 头的原始值(空/缺失 → 默认链) */
export function resolveChainKey(headerValue: string | undefined | null): string {
  const key = headerValue?.trim()
  if (!key) return defaultChainKey
  if (!registry.has(key)) {
    throw new Error(`未知链: ${key}(可选: ${knownChainKeys().join('/')})`)
  }
  return key
}
