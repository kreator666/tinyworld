import { sepolia } from 'viem/chains'
import DIDIdentityJson from '../abi/DIDIdentity.json'
import DIDPartsJson from '../abi/DIDParts.json'
import { toChainParts, type ChainPart } from '../data/equipmentCatalog'

// ============================================================
// 合约地址按链配置:新增/更换网络时只需在 CONTRACTS_BY_CHAIN 中加一项
// ============================================================

export interface ChainContracts {
  identity: `0x${string}`
  parts: `0x${string}`
  rpc: string // 无钱包时的只读回退 RPC
  explorer: string // 区块浏览器地址(用于拼接 tx/address 链接)
}

export const CONTRACTS_BY_CHAIN: Record<number, ChainContracts> = {
  // Sepolia 测试网(2026-07 部署)
  [sepolia.id]: {
    identity: '0x363AF72fC15af43BfEA47C1ED09128Cd994946c1',
    parts: '0xACa57ACa9F8FF68Dbf74E2baAB65f88Ec2515959',
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
  },
}

export const TARGET_CHAIN = sepolia
export const TARGET_CHAIN_ID = sepolia.id // 11155111

const ACTIVE = CONTRACTS_BY_CHAIN[TARGET_CHAIN_ID]

export const IDENTITY_ADDRESS = ACTIVE.identity
export const PARTS_ADDRESS = ACTIVE.parts

export const identityAbi = DIDIdentityJson.abi
export const partsAbi = DIDPartsJson.abi

// 无钱包时的只读回退 RPC
export const FALLBACK_RPC = ACTIVE.rpc

export const explorerTx = (hash: string) => `${ACTIVE.explorer}/tx/${hash}`
export const explorerAddress = (addr: string) => `${ACTIVE.explorer}/address/${addr}`

// ============================================================
// 链上配件注册表:链上 uint256 id ↔ 本地 SVG 部件 id
// 由 equipmentCatalog 自动生成;slot: 0头 1身 2配饰 3宠物
// ============================================================

export type { ChainPart }

export const chainParts: ChainPart[] = toChainParts()

export const SLOT_TO_CATEGORY = ['head', 'body', 'accessory', 'pet'] as const

export const partByChainId = (id: number | bigint) => chainParts.find((p) => p.id === Number(id))

export const partByLocalId = (localId: string) => chainParts.find((p) => p.localId === localId)
