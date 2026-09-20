import { sepolia, avalancheFuji, type Chain } from 'viem/chains'
import DIDIdentityJson from '../abi/DIDIdentity.json'
import DIDPartsJson from '../abi/DIDParts.json'
import { toChainParts, type ChainPart } from '../data/equipmentCatalog'
import type { ChainType } from '../types'

// ============================================================
// 链配置(纯数据,本地兜底副本):
// 运行时以 agent 服务 GET /chains 返回的 chains 表为准,服务不可达时用这份兜底。
// 当前激活链由 store/chainConfigStore.ts 管理(导航栏按钮切换)。
// ============================================================

export type ChainKey = 'sepolia' | 'fuji'

export interface ChainContracts {
  key: ChainKey
  name: ChainType // 短链名,用于 UI 展示与 NFT 卡的链标
  chainId: number
  chain: Chain // viem 链定义(切链参数/原生币种都从这里取)
  identity: `0x${string}`
  parts: `0x${string}`
  rpc: string // 无钱包时的只读回退 RPC
  explorer: string // 区块浏览器地址(用于拼接 tx/address 链接)
}

// 素材(角色库/装备目录)全链共用一套,与链无关;这里只放合约地址等链上信息
export const CONTRACTS_BY_KEY: Record<ChainKey, ChainContracts> = {
  // Sepolia 测试网(2026-07 部署)
  sepolia: {
    key: 'sepolia',
    name: 'Sepolia',
    chainId: 11155111,
    chain: sepolia,
    identity: '0x363AF72fC15af43BfEA47C1ED09128Cd994946c1',
    parts: '0xACa57ACa9F8FF68Dbf74E2baAB65f88Ec2515959',
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
  },
  // Avalanche Fuji 测试网(2026-09 部署,链ID 43113)
  fuji: {
    key: 'fuji',
    name: 'Fuji',
    chainId: 43113,
    chain: avalancheFuji,
    identity: '0x15dC02b5678b8454C75EeA0208C1C027b1903d9c',
    parts: '0xdac819D6B834E26B23EE30Edc9C13eA0a4b834f2',
    rpc: 'https://api.avax-test.network/ext/bc/C/rpc',
    explorer: 'https://testnet.snowtrace.io',
  },
}

export const identityAbi = DIDIdentityJson.abi
export const partsAbi = DIDPartsJson.abi

// ============================================================
// 链上配件注册表:链上 uint256 id ↔ 本地 SVG 部件 id
// 由 equipmentCatalog 自动生成;slot: 0头 1身 2配饰 3宠物
// ============================================================

export type { ChainPart }

export const chainParts: ChainPart[] = toChainParts()

export const SLOT_TO_CATEGORY = ['head', 'body', 'accessory', 'pet'] as const

export const partByChainId = (id: number | bigint) => chainParts.find((p) => p.id === Number(id))

export const partByLocalId = (localId: string) => chainParts.find((p) => p.localId === localId)
