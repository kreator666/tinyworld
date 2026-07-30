import { sepolia } from 'viem/chains'
import DIDIdentityJson from '../abi/DIDIdentity.json'
import DIDPartsJson from '../abi/DIDParts.json'
import { toChainParts, type ChainPart } from '../data/equipmentCatalog'

// ============================================================
// Sepolia 链上合约配置(2026-07 部署)
// ============================================================

export const TARGET_CHAIN = sepolia
export const TARGET_CHAIN_ID = sepolia.id // 11155111

export const IDENTITY_ADDRESS = '0x363AF72fC15af43BfEA47C1ED09128Cd994946c1' as const
export const PARTS_ADDRESS = '0xACa57ACa9F8FF68Dbf74E2baAB65f88Ec2515959' as const

export const identityAbi = DIDIdentityJson.abi
export const partsAbi = DIDPartsJson.abi

// 无钱包时的只读回退 RPC
export const FALLBACK_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'

export const explorerTx = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`
export const explorerAddress = (addr: string) => `https://sepolia.etherscan.io/address/${addr}`

// ============================================================
// 链上配件注册表:链上 uint256 id ↔ 本地 SVG 部件 id
// 由 equipmentCatalog 自动生成;slot: 0头 1身 2配饰 3宠物
// ============================================================

export type { ChainPart }

export const chainParts: ChainPart[] = toChainParts()

export const SLOT_TO_CATEGORY = ['head', 'body', 'accessory', 'pet'] as const

export const partByChainId = (id: number | bigint) => chainParts.find((p) => p.id === Number(id))

export const partByLocalId = (localId: string) => chainParts.find((p) => p.localId === localId)
