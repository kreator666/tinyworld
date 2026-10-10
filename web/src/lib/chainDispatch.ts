import { Buffer } from 'buffer'
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import type { Address } from 'viem'
import * as evm from './chain'
import * as sol from './chainSolana'
import { getActiveChain } from '../store/chainConfigStore'
import type { EvmUnsignedTx, SolanaUnsignedTx, UnsignedTx } from './agentApi'
import { useAppStore } from '../store/appStore'
import type { WalletLogin } from '../types'
import type { ChainContracts } from './contracts'
import type { ChainIdentityState, ChainPartAsset, ChainPartState, MintedAgent } from './chain'
import { isValidSolanaAddress } from './chainSolana'
import {
  SolanaWalletError,
  getActiveSolanaAddress,
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

async function latestBlockhashWithFailover(rpcs: string[]): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  let lastErr: unknown = null
  for (const url of rpcs) {
    try {
      return await new Connection(url, 'confirmed').getLatestBlockhash('confirmed')
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function sendRawWithFailover(raw: Uint8Array, rpcs: string[]): Promise<string> {
  let lastErr: unknown = null
  for (const url of rpcs) {
    try {
      return await new Connection(url, 'confirmed').sendRawTransaction(raw)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 链上确认超时:交易已广播但预算内未确认(仍在打包或 RPC 不可达),不视为失败 */
class SolanaConfirmTimeoutError extends Error {
  constructor() {
    super('等待链上确认超时,交易可能仍在打包')
    this.name = 'SolanaConfirmTimeoutError'
  }
}

const CONFIRM_POLL_INTERVAL_MS = 2000
const CONFIRM_BUDGET_MS = 60000

/** 轮询 getSignatureStatuses 等待确认(纯 HTTP,不依赖 websocket 事件——公共 RPC 的 ws 常不可用)。
 *  交易在链上失败(st.err)立即抛错;预算耗尽抛 SolanaConfirmTimeoutError */
async function confirmWithFailover(signature: string, rpcs: string[]): Promise<void> {
  const deadline = Date.now() + CONFIRM_BUDGET_MS
  let lastErr: unknown = null
  for (const url of rpcs) {
    const conn = new Connection(url, 'confirmed')
    while (Date.now() < deadline) {
      try {
        const { value } = await conn.getSignatureStatuses([signature])
        const st = value[0]
        if (st) {
          if (st.err) throw new Error(`交易上链失败: ${JSON.stringify(st.err)}`)
          const cs = st.confirmationStatus as string | undefined
          if (cs === 'confirmed' || cs === 'finalized') return
        }
        lastErr = null
      } catch (e) {
        lastErr = e
      }
      await new Promise((r) => setTimeout(r, CONFIRM_POLL_INTERVAL_MS))
    }
  }
  if (lastErr) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  throw new SolanaConfirmTimeoutError()
}

/** 确认等待不阻断主流程:超时(尚未确认)直接放行,后端 sign-confirm 会再核实并记待确认;
 *  只有链上明确失败(st.err)才抛错中断 */
async function confirmOrDefer(signature: string, rpcs: string[]): Promise<void> {
  try {
    await confirmWithFailover(signature, rpcs)
  } catch (err) {
    if (err instanceof SolanaConfirmTimeoutError) return
    throw err
  }
}

/** Solana 用户钱包签名模式:Phantom 逐笔签名(base64 反序列化),经交易自带 RPC 端点发送并确认
 *
 * 与 chainSolana.sendTx 同一策略:优先 signTransaction + 前端直连 RPC 发送
 * (避开 Phantom 中继在部分网络的 403),钱包不支持 signTransaction 时退回中继发送。
 * legacy 交易(Meteora)签名前刷新 blockhash(feePayer 即用户);
 * VersionedTransaction(Jupiter)的 blockhash 由 Jupiter 组装时内嵌,不做改动。
 */
async function sendSolanaTransactions(unsignedTxs: UnsignedTx[]): Promise<string[]> {
  const walletAddr = getActiveSolanaAddress()
  if (!walletAddr) throw new Error('请先连接 Phantom 钱包')
  const signatures: string[] = []
  for (const item of unsignedTxs) {
    if (!isSolanaUnsignedTx(item)) throw new Error('待签名交易不是 Solana 格式')
    const tx = deserializeSolanaTx(item.tx)
    const latest = await latestBlockhashWithFailover(item.rpcs)
    if (tx instanceof Transaction) {
      tx.feePayer = new PublicKey(walletAddr)
      tx.recentBlockhash = latest.blockhash
      tx.lastValidBlockHeight = latest.lastValidBlockHeight
    }
    let signed: Transaction | VersionedTransaction
    try {
      signed = (await solanaSignTransaction(tx)) as Transaction | VersionedTransaction
    } catch (err) {
      if (err instanceof SolanaWalletError && err.code === 'UNSUPPORTED') {
        const signature = await solanaSignAndSend(tx)
        await confirmOrDefer(signature, item.rpcs)
        signatures.push(signature)
        continue
      }
      throw err
    }
    const signature = await sendRawWithFailover(signed.serialize(), item.rpcs)
    await confirmOrDefer(signature, item.rpcs)
    signatures.push(signature)
  }
  return signatures
}

export async function sendTransactions(owner: string, unsignedTxs: UnsignedTx[]): Promise<string[]> {
  if (isSolana()) return sendSolanaTransactions(unsignedTxs)
  return evm.sendTransactions(owner as Address, unsignedTxs as EvmUnsignedTx[])
}

export function explainChainError(err: unknown): string {
  return isSolana() ? sol.explainSolanaChainError(err) : evm.explainChainError(err)
}
