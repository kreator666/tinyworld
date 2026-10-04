import type { Address } from 'viem'
import * as evm from './chain'
import * as sol from './chainSolana'
import { getActiveChain } from '../store/chainConfigStore'
import type { UnsignedTx } from './agentApi'
import type { WalletLogin } from '../types'
import type { ChainContracts } from './contracts'
import type { ChainIdentityState, ChainPartAsset, ChainPartState, MintedAgent } from './chain'

// ============================================================
// 链族分发层:每个 action 按当前激活链的 family 路由到
// EVM(lib/chain.ts)或 Solana(lib/chainSolana.ts)实现,调用方零感知。
// EVM 路径就是原 lib/chain.ts 的函数,行为不变。
// 注意:写操作返回值统一为 string——EVM 返回 0x tx hash,Solana 返回 base58 signature。
// ============================================================

const isSolana = () => (getActiveChain().family ?? 'evm') === 'solana'

export type { ChainIdentityState, ChainPartAsset, ChainPartState, MintedAgent }

export interface RegisterProgress {
  current: number
  total: number
  txHash: string | null
  chainId: number | null
}

/** 钱包是否已处于激活链可用状态:EVM 比对 chainId;Solana 恒 true——Phantom 的 cluster 切换是用户在钱包内手动完成的,代码无法探测 */
export function isWalletOnActiveChain(login: WalletLogin | null, active: ChainContracts): boolean {
  if ((active.family ?? 'evm') === 'solana') return true
  return !!login && login.chainId === active.chainId
}

/** 确保钱包切到目标链:Solana 为 no-op(Phantom cluster 手动切换) */
export async function ensureTargetChain(): Promise<void> {
  if (isSolana()) return
  return evm.ensureTargetChain()
}

export async function fetchChainState(address: string): Promise<ChainIdentityState> {
  return isSolana() ? sol.fetchChainState(address) : evm.fetchChainState(address as Address)
}

export async function fetchOwnedPartCount(address: string): Promise<number> {
  return isSolana() ? sol.fetchOwnedPartCount(address) : evm.fetchOwnedPartCount(address as Address)
}

export async function checkNameAvailable(name: string): Promise<boolean> {
  return isSolana() ? sol.checkNameAvailable(name) : evm.checkNameAvailable(name)
}

export async function fetchMintedAgents(): Promise<MintedAgent[]> {
  return isSolana() ? sol.fetchMintedAgents() : evm.fetchMintedAgents()
}

export async function fetchAgentPublic(tokenId: number): Promise<{
  tokenId: number
  name: string
  owner: string
  bio: string
  equipped: import('../types').Equipped
}> {
  return isSolana() ? sol.fetchAgentPublic(tokenId) : evm.fetchAgentPublic(tokenId)
}

export async function fetchPersona(tokenId: number): Promise<{ uri: string; contentHash: `0x${string}` }> {
  return isSolana() ? sol.fetchPersona(tokenId) : evm.fetchPersona(tokenId)
}

/** Solana 分支忽略 bio/profileURI(程序无此字段) */
export async function mintIdentity(owner: string, name: string, profileURI: string): Promise<string> {
  return isSolana() ? sol.mintIdentity(owner, name, profileURI) : evm.mintIdentity(owner as Address, name, profileURI)
}

export async function equipPart(owner: string, tokenId: number, slot: number, partChainId: number): Promise<string> {
  return isSolana() ? sol.equipPart(owner, tokenId, slot, partChainId) : evm.equipPart(owner as Address, tokenId, slot, partChainId)
}

export async function unequipPart(owner: string, tokenId: number, slot: number): Promise<string> {
  return isSolana() ? sol.unequipPart(owner, tokenId, slot) : evm.unequipPart(owner as Address, tokenId, slot)
}

/** Solana 镜像模式:uri 忽略,hash+空 arweave_id 上链(详见 chainSolana.setPersonaOnChain) */
export async function setPersonaOnChain(owner: string, tokenId: number, uri: string, contentHash: `0x${string}`): Promise<string> {
  return isSolana() ? sol.setPersonaOnChain(owner, tokenId, uri, contentHash) : evm.setPersonaOnChain(owner as Address, tokenId, uri, contentHash)
}

export async function isPartsOwner(account: string): Promise<boolean> {
  return isSolana() ? sol.isPartsOwner(account) : evm.isPartsOwner(account as Address)
}

export async function isPartsMinter(account: string): Promise<boolean> {
  return isSolana() ? sol.isPartsMinter(account) : evm.isPartsMinter(account as Address)
}

export async function fetchPartStates(): Promise<ChainPartState[]> {
  return isSolana() ? sol.fetchPartStates() : evm.fetchPartStates()
}

export async function registerPart(owner: string, chainId: number, slot: number, rarity: number, maxSupply: number): Promise<string> {
  return isSolana() ? sol.registerPart(owner, chainId, slot, rarity, maxSupply) : evm.registerPart(owner as Address, chainId, slot, rarity, maxSupply)
}

export async function registerPartsBatch(
  owner: string,
  parts: { chainId: number; slot: number; rarity: number; maxSupply: number; name: string }[],
  onProgress?: (p: RegisterProgress) => void,
): Promise<string[]> {
  return isSolana()
    ? sol.registerPartsBatch(owner, parts, onProgress)
    : evm.registerPartsBatch(owner as Address, parts, onProgress as (p: evm.RegisterProgress) => void)
}

export async function mintPartsBatch(owner: string, to: string, ids: bigint[], amounts: bigint[]): Promise<string> {
  return isSolana() ? sol.mintPartsBatch(owner, to, ids, amounts) : evm.mintPartsBatch(owner as Address, to as Address, ids, amounts)
}

export async function approveErc20(owner: string, token: string, spender: string, amount: bigint): Promise<string> {
  if (isSolana()) throw new Error('Solana 链不支持 ERC20 授权')
  return evm.approveErc20(owner as Address, token as Address, spender as Address, amount)
}

export async function sendTransactions(owner: string, unsignedTxs: UnsignedTx[]): Promise<string[]> {
  if (isSolana()) throw new Error('Solana 链暂不支持该交易发送方式')
  return evm.sendTransactions(owner as Address, unsignedTxs)
}

export function explainChainError(err: unknown): string {
  return isSolana() ? sol.explainSolanaChainError(err) : evm.explainChainError(err)
}
