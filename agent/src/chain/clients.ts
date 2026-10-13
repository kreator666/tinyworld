import { createPublicClient, createWalletClient, http, isHex, type Account, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia, avalancheFuji } from 'viem/chains'
import type { ChainConfig } from '../config'
import { getChainContext } from './registry'

// 缓存 client 的具体类型:chain 已绑定(非 undefined),调用方 writeContract/readContract 无需再传 chain
export type CachedPublicClient = PublicClient<Transport, Chain>
export type CachedWalletClient = WalletClient<Transport, Chain, Account>

// ============================================================
// 多链 client 工厂(方案A 地基):getChainConfig / getPublicClient / getWalletClient
// - 每个 chainKey 缓存一个 viem client 实例
// - viem 链定义集中登记,未登记直接抛错(旧实现静默回落 sepolia,签名会串链,属隐患)
// - Solana 家族链在 EVM 工厂入口明确抛错(其连接逻辑在 personaSolana / skills 内自管)
// - env 覆盖(CHAIN_RPC / DID_IDENTITY_ADDRESS 等)仍在 config.ts 内只作用于 TARGET_CHAIN 链,行为不变
// ============================================================

/** viem Chain 定义表(chain 对象决定交易签名的 chainId / eip155 编码);新增 EVM 链在此登记 */
const VIEM_CHAIN_DEFS: Record<number, Chain> = {
  [sepolia.id]: sepolia,
  [avalancheFuji.id]: avalancheFuji,
}

/** 取链配置(env 覆盖已按 config.ts 规则应用);未知 chainKey 抛错 */
export function getChainConfig(chainKey: string): ChainConfig {
  return getChainContext(chainKey).cfg
}

/** 链的 viem 定义;Solana 家族或未登记的 chainId 直接抛错 */
export function viemChainDef(chainKey: string): Chain {
  const { family, cfg } = getChainContext(chainKey)
  if (family !== 'evm') {
    throw new Error(`链 ${chainKey}(${cfg.name})是 ${family} 家族,不提供 EVM client;请走该家族自己的连接逻辑`)
  }
  const def = VIEM_CHAIN_DEFS[cfg.chainId]
  if (!def) {
    throw new Error(`chainId ${cfg.chainId}(${chainKey})未登记 viem 链定义,请在 clients.ts 的 VIEM_CHAIN_DEFS 补充`)
  }
  return def
}

const publicClients = new Map<string, CachedPublicClient>()

/** 只读客户端(按 chainKey 缓存);报价/余额/回执等待等所有读路径统一入口 */
export function getPublicClient(chainKey: string): CachedPublicClient {
  let client = publicClients.get(chainKey)
  if (!client) {
    const cfg = getChainConfig(chainKey)
    client = createPublicClient({ chain: viemChainDef(chainKey), transport: http(cfg.rpc) })
    publicClients.set(chainKey, client)
  }
  return client
}

const walletClients = new Map<string, CachedWalletClient>()

/**
 * 热钱包/签名客户端(按 chainKey + 地址缓存)。
 * 同一把 EVM 私钥跨链地址相同(AGENT_PRIVATE_KEY 单钥多链,天然成立),调用方按需传入;
 * Solana 家族链在此明确抛错(用 agentSolanaKey 走 skills 内自管的 Solana 连接)。
 */
export function getWalletClient(chainKey: string, privateKey: Hex): CachedWalletClient {
  if (!isHex(privateKey) || privateKey.length !== 66) throw new Error('私钥格式无效(期望 0x + 64 hex)')
  const account = privateKeyToAccount(privateKey)
  const cacheKey = `${chainKey}:${account.address}`
  let client = walletClients.get(cacheKey)
  if (!client) {
    const cfg = getChainConfig(chainKey)
    client = createWalletClient({ account, chain: viemChainDef(chainKey), transport: http(cfg.rpc) })
    walletClients.set(cacheKey, client)
  }
  return client
}
