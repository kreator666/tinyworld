import {
  createPublicClient,
  createWalletClient,
  http,
  isHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia, avalancheFuji } from 'viem/chains'
import { config } from '../config'

// ============================================================
// DeFi 链交互(M4):Agent 热钱包签名,V2 风格 Router 兑换
// 只操作热钱包自己的资金(少量测试币),用户本金不经过这里(设计文档 §7.1)
// ============================================================

const VIEM_CHAINS = { [sepolia.id]: sepolia, [avalancheFuji.id]: avalancheFuji } as const
const viemChain = VIEM_CHAINS[config.chain.chainId as keyof typeof VIEM_CHAINS] ?? sepolia

const publicClient = createPublicClient({ chain: viemChain, transport: http(config.chain.rpc) })

// V2 Router 只用到两个方法:报价 + 原生币换代币(方法名按链变体:AVAX/ETH)
const routerAbi = [
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'swapExactAVAXForTokens',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'swapExactETHForTokens',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const

const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

function agentAccount() {
  const key = config.agentPrivateKey
  if (!key || !isHex(key)) return null
  return privateKeyToAccount(key as Hex)
}

/** 热钱包地址;未配置 AGENT_PRIVATE_KEY 返回 null */
export function getAgentWalletAddress(): Address | null {
  return agentAccount()?.address ?? null
}

export function hasAgentKey(): boolean {
  return agentAccount() !== null
}

/** 热钱包原生币余额(wei) */
export async function getNativeBalance(address: Address): Promise<bigint> {
  return publicClient.getBalance({ address })
}

/** ERC20 余额(最小单位) */
export async function getTokenBalance(token: Address, owner: Address): Promise<bigint> {
  return (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  })) as bigint
}

/** Router 报价:amountIn(wei,原生币)→ 预计可得 token 最小单位 */
export async function quoteSwap(amountInWei: bigint, tokenOut: Address): Promise<bigint> {
  const path = [config.chain.defi.wNative, tokenOut]
  const amounts = (await publicClient.readContract({
    address: config.chain.defi.router,
    abi: routerAbi,
    functionName: 'getAmountsOut',
    args: [amountInWei, path],
  })) as bigint[]
  return amounts[amounts.length - 1]
}

export interface SwapResult {
  txHash: Hex
  amountOut: bigint // 实际到账(余额差核实,防"假成功")
}

/**
 * 执行原生币 → 代币兑换:发交易 → 等回执 → 核实代币余额真实增长
 * 回执 status 失败或余额没增长都视为失败(抛错)
 */
export async function executeSwap(amountInWei: bigint, amountOutMin: bigint, tokenOut: Address): Promise<SwapResult> {
  const account = agentAccount()
  if (!account) throw new Error('未配置执行密钥(AGENT_PRIVATE_KEY)')
  const wallet = createWalletClient({ account, chain: viemChain, transport: http(config.chain.rpc) })

  const before = await getTokenBalance(tokenOut, account.address)
  const fnName = config.chain.chainId === avalancheFuji.id ? 'swapExactAVAXForTokens' : 'swapExactETHForTokens'
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)

  const txHash = await wallet.writeContract({
    address: config.chain.defi.router,
    abi: routerAbi,
    functionName: fnName,
    args: [amountOutMin, [config.chain.defi.wNative, tokenOut], account.address, deadline],
    value: amountInWei,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
  if (receipt.status !== 'success') {
    throw new Error(`交易上链但执行失败(revert): ${txHash}`)
  }
  const after = await getTokenBalance(tokenOut, account.address)
  const amountOut = after - before
  if (amountOut <= 0n) {
    throw new Error(`交易成功但代币余额未增长(假成功): ${txHash}`)
  }
  return { txHash, amountOut }
}
