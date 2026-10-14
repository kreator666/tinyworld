import { config, ALL_CHAINS, type ChainConfig } from '../config'
import type { ChainRow } from '../db'

// ============================================================
// 链注册表(多链重构·方案A):请求级链分派的核心。
// 单进程同时服务多链:每条链一个 ChainContext,链家族(evm/solana)决定实现分派。
// 链身份来源优先级:X-Chain-Key 请求头 → 默认链(TARGET_CHAIN,向后兼容)。
// ============================================================

export interface ChainContext {
  chainKey: string // chains 表主键,如 'solana-devnet' / 'fuji'
  family: 'evm' | 'solana'
  cfg: ChainConfig
}

const registry = new Map<string, ChainContext>()

for (const [chainKey, cfg] of Object.entries(ALL_CHAINS)) {
  registry.set(chainKey, { chainKey, family: cfg.family, cfg })
}

// ============================================================
// DB 配置覆盖层(链配置下沉):chains 表 config 列是权威。
// 启动时 index.ts 调 applyDbChainConfigs 注入;DB 不可达/无行时覆盖层为空,
// getChainContext 回落到 config.ts 的 ALL_CHAINS,行为与改造前一致。
// 覆盖层对 ALL_CHAINS 内置链做浅合并;DB-only 新链走 applyDbChains 整行注册(见下)。
// ============================================================
const dbOverlay = new Map<string, Record<string, unknown>>()
const mergedCache = new Map<string, ChainContext>()

function mergeChainConfig(chainKey: string): ChainContext {
  const base = registry.get(chainKey)!
  const overlay = dbOverlay.get(chainKey)
  if (!overlay || Object.keys(overlay).length === 0) return base
  const deep = <T>(a: T, b: unknown): T => (a && b && typeof a === 'object' && typeof b === 'object' ? ({ ...(a as object), ...(b as object) } as T) : ((b as T) ?? a))
  const cfg: ChainConfig = {
    ...base.cfg,
    ...(overlay as Partial<ChainConfig>),
    defi: deep(base.cfg.defi, overlay.defi),
    aave: deep(base.cfg.aave, overlay.aave),
    solana: deep(base.cfg.solana, overlay.solana),
  }
  return { chainKey, family: cfg.family, cfg }
}

/** 启动时(chains 表种子写入后)注入/刷新 DB 配置覆盖层 */
export function applyDbChainConfigs(rows: Record<string, Record<string, unknown>>): void {
  dbOverlay.clear()
  mergedCache.clear()
  for (const [key, cfg] of Object.entries(rows)) {
    if (registry.has(key)) dbOverlay.set(key, cfg)
  }
}

// ============================================================
// DB-only 动态链:加新链不用改 config.ts 发版重启。
// chains 表行 = 全量配置:固有列 + config JSONB 直接构造 ChainContext 注册进 registry
// (不做 overlay 合并;行删除或 enabled=false 时注销,ALL_CHAINS 内置链永不删)。
// 已登记的链 getChainContext/resolveChainKey/chainKeyByChainId 自动覆盖。
// ============================================================
const dbAddedChains = new Set<string>()

export function applyDbChains(rows: ChainRow[]): void {
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row.enabled) continue
    seen.add(row.chain_key)
    if (Object.prototype.hasOwnProperty.call(ALL_CHAINS, row.chain_key)) continue
    const family = row.family === 'solana' ? 'solana' : 'evm'
    const cfgJson = (row.config ?? {}) as Partial<ChainConfig>
    // 固有列(表结构)优先;config JSONB 补充扩展字段(defi/aave/solana/partsClaim/rpcFallbacks 等)
    const cfg: ChainConfig = {
      ...cfgJson,
      family,
      name: row.name,
      chainId: row.chain_id,
      rpc: row.rpc,
      explorer: row.explorer,
      identityAddress: row.identity_address,
      partsAddress: row.parts_address,
    }
    registry.set(row.chain_key, { chainKey: row.chain_key, family, cfg })
    dbAddedChains.add(row.chain_key)
  }
  // 行消失/禁用:注销此前由 DB 添加的链(内置链不动)
  for (const key of [...dbAddedChains]) {
    if (!seen.has(key)) {
      registry.delete(key)
      dbAddedChains.delete(key)
    }
  }
  mergedCache.clear()
}

/** 已知链(ALL_CHAINS 的键) */
export function knownChainKeys(): string[] {
  return [...registry.keys()]
}

export function isKnownChainKey(chainKey: string): boolean {
  return registry.has(chainKey)
}

export function getChainContext(chainKey: string): ChainContext {
  if (!registry.has(chainKey)) {
    throw new Error(`未知链: ${chainKey}(可选: ${knownChainKeys().join('/')})`)
  }
  // DB 优先:有覆盖层时用合并后的配置,否则原样返回(缓存避免每次调用重新合并)
  let ctx = mergedCache.get(chainKey)
  if (!ctx) {
    ctx = dbOverlay.has(chainKey) ? mergeChainConfig(chainKey) : registry.get(chainKey)!
    mergedCache.set(chainKey, ctx)
  }
  return ctx
}

/** 默认链 = TARGET_CHAIN(迁移基线,也是不带 X-Chain-Key 请求的回落链) */
export const defaultChainKey = config.chainKey

/** chainId → chainKey(EVM 链按 chainId 反查;找不到返回 null,调用方决定容错或拒绝) */
export function chainKeyByChainId(chainId: number): string | null {
  for (const [key, ctx] of registry) {
    if (ctx.cfg.chainId === chainId) return key
  }
  return null
}

/** 从请求解析链:chainKey 入参为 X-Chain-Key 头的原始值(空/缺失 → 默认链) */
export function resolveChainKey(headerValue: string | undefined | null): string {
  const key = headerValue?.trim()
  if (!key) return defaultChainKey
  if (!registry.has(key)) {
    throw new Error(`未知链: ${key}(可选: ${knownChainKeys().join('/')})`)
  }
  return key
}
