import { Buffer } from 'buffer'
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import type { Address } from 'viem'
import * as evm from './chain'
import * as sol from './chainSolana'
import { getActiveChain } from '../store/chainConfigStore'
import type { EvmUnsignedTx, SolanaUnsignedTx, UnsignedTx } from './agentApi'
import { broadcastSignedTxs, fetchSolanaBlockhash } from './agentApi'
import { useAppStore } from '../store/appStore'
import type { WalletLogin } from '../types'
import type { ChainContracts } from './contracts'
import type { ChainIdentityState, ChainPartAsset, ChainPartState, MintedAgent } from './chain'
import { isValidSolanaAddress } from './chainSolana'
import {
  SolanaWalletError,
  getActiveSolanaAddress,
  getActiveSolanaProvider,
  solanaSignAndSend,
  solanaSignTransaction,
} from './walletSolana'

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

/** 钱包是否已处于激活链可用状态:EVM 比对 chainId;Solana 需 walletKind='solana' 且地址合法 */
export function isWalletOnActiveChain(login: WalletLogin | null, active: ChainContracts): boolean {
  if ((active.family ?? 'evm') === 'solana') {
    const { walletKind, address } = useAppStore.getState()
    return walletKind === 'solana' && !!login && login.address === address && isValidSolanaAddress(login.address)
  }
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

/** Solana 反序列化:优先 VersionedTransaction(Jupiter),失败退回 legacy Transaction(Meteora SDK) */
function isSolanaUnsignedTx(item: UnsignedTx): item is SolanaUnsignedTx {
  return 'kind' in item && item.kind === 'solana'
}

function deserializeSolanaTx(txBase64: string): Transaction | VersionedTransaction {
  const bytes = new Uint8Array(Buffer.from(txBase64, 'base64'))
  try {
    return VersionedTransaction.deserialize(bytes)
  } catch {
    return Transaction.from(bytes)
  }
}

/** 交易的 feePayer(= 必须签名的账户):legacy 取 tx.feePayer,v0 取 staticAccountKeys[0] */
function feePayerOf(tx: Transaction | VersionedTransaction): PublicKey | null {
  if (tx instanceof Transaction) return tx.feePayer ?? null
  return tx.message.staticAccountKeys[0] ?? null
}

/** Solana 用户钱包签名模式:
 *
 * 浏览器直连公共 Solana RPC(取 blockhash/发交易/等确认)会被 403 拦截,因此:
 * 1. legacy 交易(Meteora)签名前经后端 /solana-blockhash 刷新 blockhash;
 * 2. Phantom 只负责签名(signTransaction;不支持的钱包退回 Phantom 中继发送);
 * 3. 签名后的 raw tx 交后端 /broadcast 经故障转移连接发送;
 * 4. 上链确认与输出解析由 sign-confirm 一并完成(后端 60s 硬超时兜底)。
 */
async function sendSolanaTransactions(unsignedTxs: UnsignedTx[], tokenId: number, protocol?: string): Promise<string[]> {
  const walletAddr = getActiveSolanaAddress()
  if (!walletAddr) throw new Error('请先连接 Phantom 钱包')
  // 本地缓存的地址可能已滞后:Phantom 里切换账户不会自动同步,以钱包当前账户为准拦截
  const liveAddr = getActiveSolanaProvider()?.publicKey?.toBase58()
  if (liveAddr && liveAddr !== walletAddr) {
    throw new Error('Phantom 当前账户已切换,与登录身份不一致,请重新连接钱包后再试')
  }
  const signedTxs: string[] = []
  for (const item of unsignedTxs) {
    if (!isSolanaUnsignedTx(item)) throw new Error('待签名交易不是 Solana 格式')
    const tx = deserializeSolanaTx(item.tx)
    // 交易由 Agent 按链上人格 owner 组装;签名账户必须与当前连接钱包一致,否则 Phantom 会拒签(报"Unexpected error")
    const payer = feePayerOf(tx)
    if (payer && payer.toBase58() !== walletAddr) {
      throw new Error(
        `这笔交易属于账户 ${payer.toBase58().slice(0, 8)}…,与当前连接的钱包不一致,请在 Phantom 切回该账户,或用该账户登录后再兑换`,
      )
    }
    if (tx instanceof Transaction) {
      const latest = await fetchSolanaBlockhash(tokenId, protocol)
      tx.feePayer = new PublicKey(walletAddr)
      tx.recentBlockhash = latest.blockhash
    }
    let signed: Transaction | VersionedTransaction
    try {
      signed = (await solanaSignTransaction(tx)) as Transaction | VersionedTransaction
    } catch (err) {
      // 钱包不支持 signTransaction:退回 Phantom 中继发送(走 Phantom 自有 RPC,不受公共 RPC 403 影响)
      if (err instanceof SolanaWalletError && err.code === 'UNSUPPORTED') {
        return [await solanaSignAndSend(tx)]
      }
      throw err
    }
    signedTxs.push(Buffer.from(signed.serialize()).toString('base64'))
  }
  const r = await broadcastSignedTxs(tokenId, signedTxs, protocol)
  return r.txHashes
}

export async function sendTransactions(
  owner: string,
  unsignedTxs: UnsignedTx[],
  opts?: { tokenId?: number; protocol?: string },
): Promise<string[]> {
  if (isSolana()) {
    if (!opts?.tokenId) throw new Error('Solana 交易发送缺少 tokenId')
    return sendSolanaTransactions(unsignedTxs, opts.tokenId, opts.protocol)
  }
  return evm.sendTransactions(owner as Address, unsignedTxs as EvmUnsignedTx[])
}

export function explainChainError(err: unknown): string {
  return isSolana() ? sol.explainSolanaChainError(err) : evm.explainChainError(err)
}
