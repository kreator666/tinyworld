import { encodeFunctionData, type Address, type Hex } from 'viem'
import { getWalletClient } from './clients'
import { getChainContext } from './registry'
import { waitForTxReceipt } from './defi'
import { config } from '../config'
import type { UnsignedTx } from './defi'

// ============================================================
// 竞技场执行入口(P3):
// 平台热钱包签名,但交易目标是 ArenaAccount.execute(target, value, data),
// 资金/头寸归属托管账户。资金出口的最后一道链上裁决在合约白名单,
// 本层只负责"包一层 + 发送 + 回执核实"。
// 内部 calldata 一律复用现有 buildUnsigned*(aave/gmx/defi 的纯 encode 函数)。
// ============================================================

/** ArenaAccount.execute 的 ABI 片段 */
const arenaAccountAbi = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
] as const

const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

/** 一笔待经 ArenaAccount 执行的内部调用(目标 = 协议合约) */
export interface ArenaCall {
  target: Address
  value: bigint // 从账户余额转给目标协议的原生币(如 Aave Gateway depositETH)
  data: Hex
}

/** 把内部调用包成发给 ArenaAccount.execute 的 unsigned tx(发送方 = 平台 executor) */
export function buildArenaTx(chainKey: string, account: Address, call: ArenaCall): UnsignedTx {
  const { cfg } = getChainContext(chainKey)
  return {
    to: account,
    data: encodeFunctionData({
      abi: arenaAccountAbi,
      functionName: 'execute',
      args: [call.target, call.value, call.data],
    }),
    value: '0',
    chainId: cfg.chainId,
    description: `ArenaAccount → ${call.target.slice(0, 8)}…`,
  }
}

/** 账户内 ERC20 approve(协议 transferFrom 扣款的前置;需赛季白名单登记 approve 选择器) */
export function buildArenaApproveCall(token: Address, spender: Address, amount: bigint): ArenaCall {
  return {
    target: token,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
  }
}

/** 从现有 buildUnsigned*(返回 to/data 的 UnsignedTx)派生 ArenaCall:换目标不换 calldata */
export function arenaCallFrom(unsigned: UnsignedTx): ArenaCall {
  return { target: unsigned.to, value: BigInt(unsigned.value), data: unsigned.data }
}

/**
 * 顺序执行一组 ArenaCall(每笔一笔独立 execute 交易):
 * 热钱包签名 → 等待回执 → status 核实。任一失败立即抛错(部分执行由调用方在落库时体现)。
 */
export async function executeArenaCalls(chainKey: string, account: Address, calls: ArenaCall[]): Promise<{ txHashes: Hex[] }> {
  if (!config.agentPrivateKey) throw new Error('未配置执行密钥(AGENT_PRIVATE_KEY)')
  const client = getWalletClient(chainKey, config.agentPrivateKey as Hex)
  const txHashes: Hex[] = []
  for (const call of calls) {
    const tx = await client.writeContract({
      address: account,
      abi: arenaAccountAbi,
      functionName: 'execute',
      args: [call.target, call.value, call.data],
    })
    const receipt = await waitForTxReceipt(chainKey, tx)
    if (receipt.status !== 'success') {
      throw new Error(`ArenaAccount.execute 交易 revert: ${tx}`)
    }
    txHashes.push(tx)
  }
  return { txHashes }
}
