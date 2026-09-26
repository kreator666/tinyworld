import {
  createPublicClient,
  createWalletClient,
  http,
  isHex,
  encodeFunctionData,
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
  {
    type: 'function',
    name: 'swapExactTokensForAVAX',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'swapExactTokensForETH',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
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
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
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

/** ERC20 授权额度(用户资金路径:查 owner 对热钱包/router 的 allowance) */
export async function getAllowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  return (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })) as bigint
}

/** Router 报价:默认原生币→代币(path [wNative, token]);reverse=true 时代币→原生币 */
export async function quoteSwap(amountIn: bigint, token: Address, reverse = false): Promise<bigint> {
  const path = reverse ? [token, config.chain.defi.wNative] : [config.chain.defi.wNative, token]
  const amounts = (await publicClient.readContract({
    address: config.chain.defi.router,
    abi: routerAbi,
    functionName: 'getAmountsOut',
    args: [amountIn, path],
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

export interface UserSwapResult {
  txHash: Hex // 最后一步 swap 的 tx
  amountOut: bigint // 热钱包 AVAX 余额实际增长(扣掉 gas 后仍应 > 0 才认可)
}

/**
 * 用户资金路径(USDC → AVAX):用户已 approve 热钱包额度,热钱包代执行、付 gas
 * 三步:transferFrom(owner→热钱包)→ approve(router)→ swapExactTokensForAVAX;
 * 任一步失败整体报错(已成功的步骤不回滚,链上状态以 tx 为准)
 */
export async function executeUserSwap(
  owner: Address,
  tokenIn: Address,
  amountIn: bigint,
  amountOutMin: bigint,
): Promise<UserSwapResult> {
  const account = agentAccount()
  if (!account) throw new Error('未配置执行密钥(AGENT_PRIVATE_KEY)')
  const wallet = createWalletClient({ account, chain: viemChain, transport: http(config.chain.rpc) })
  const { router, wNative } = config.chain.defi

  // 1. 把用户的代币转入热钱包(依赖用户对热钱包的 approve 额度)
  const t1 = await wallet.writeContract({
    address: tokenIn,
    abi: erc20Abi,
    functionName: 'transferFrom',
    args: [owner, account.address, amountIn],
  })
  const r1 = await publicClient.waitForTransactionReceipt({ hash: t1, timeout: 120_000 })
  if (r1.status !== 'success') throw new Error(`transferFrom 失败(用户额度不足或余额不足): ${t1}`)

  // 2. 热钱包授权 router 使用这笔代币
  const t2 = await wallet.writeContract({
    address: tokenIn,
    abi: erc20Abi,
    functionName: 'approve',
    args: [router, amountIn],
  })
  const r2 = await publicClient.waitForTransactionReceipt({ hash: t2, timeout: 120_000 })
  if (r2.status !== 'success') throw new Error(`approve(router) 失败: ${t2}(代币已在热钱包,需人工收尾)`)

  // 3. 兑换为原生币,回到热钱包(方法名按链变体:AVAX/ETH)
  const before = await publicClient.getBalance({ address: account.address })
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
  const swapOutFn = config.chain.chainId === avalancheFuji.id ? 'swapExactTokensForAVAX' : 'swapExactTokensForETH'
  const t3 = await wallet.writeContract({
    address: router,
    abi: routerAbi,
    functionName: swapOutFn,
    args: [amountIn, amountOutMin, [tokenIn, wNative], account.address, deadline],
  })
  const r3 = await publicClient.waitForTransactionReceipt({ hash: t3, timeout: 120_000 })
  if (r3.status !== 'success') throw new Error(`swap 执行失败(revert): ${t3}`)

  // 名义到账 = 余额差 + 这一步的 gas(gas 也扣在同一个原生币余额里,要加回来才是兑换所得)
  const after = await publicClient.getBalance({ address: account.address })
  const gasCost = r3.gasUsed * r3.effectiveGasPrice
  const amountOut = after - before + gasCost
  if (amountOut <= 0n) {
    throw new Error(`交易成功但原生币余额未增长(假成功): ${t3}`)
  }
  return { txHash: t3, amountOut }
}

// ============================================================
// 用户钱包签名模式(M4+):Agent 只组装 unsigned tx,前端钱包签名,后端广播
// ============================================================

export interface UnsignedTx {
  to: Address
  data: Hex
  value: string // wei 字符串,便于 JSON 传输
  chainId: number
  description: string //  human-readable,如 "AVAX → USDC"
}

function swapDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 600)
}

function nativeSwapOutFn(): 'swapExactAVAXForTokens' | 'swapExactETHForTokens' {
  return config.chain.chainId === avalancheFuji.id ? 'swapExactAVAXForTokens' : 'swapExactETHForTokens'
}

function tokenSwapOutFn(): 'swapExactTokensForAVAX' | 'swapExactTokensForETH' {
  return config.chain.chainId === avalancheFuji.id ? 'swapExactTokensForAVAX' : 'swapExactTokensForETH'
}

/** 用户钱包模式:组装 原生币 → 代币 的 unsigned tx */
export function buildUnsignedNativeToTokenSwap(
  user: Address,
  amountInWei: bigint,
  amountOutMin: bigint,
  tokenOut: Address,
): UnsignedTx {
  const data = encodeFunctionData({
    abi: routerAbi,
    functionName: nativeSwapOutFn(),
    args: [amountOutMin, [config.chain.defi.wNative, tokenOut], user, swapDeadline()],
  })
  return {
    to: config.chain.defi.router,
    data,
    value: amountInWei.toString(),
    chainId: config.chain.chainId,
    description: `${config.chain.defi.nativeSymbol} → ${tokenOut}`,
  }
}

/** 用户钱包模式:组装 代币 → 原生币 的 unsigned tx */
export function buildUnsignedTokenToNativeSwap(
  user: Address,
  tokenIn: Address,
  amountIn: bigint,
  amountOutMin: bigint,
): UnsignedTx {
  const data = encodeFunctionData({
    abi: routerAbi,
    functionName: tokenSwapOutFn(),
    args: [amountIn, amountOutMin, [tokenIn, config.chain.defi.wNative], user, swapDeadline()],
  })
  return {
    to: config.chain.defi.router,
    data,
    value: '0',
    chainId: config.chain.chainId,
    description: `${tokenIn} → ${config.chain.defi.nativeSymbol}`,
  }
}

/** 用户钱包模式:组装 ERC20 approve 的 unsigned tx */
export function buildUnsignedErc20Approve(token: Address, spender: Address, amount: bigint): UnsignedTx {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  })
  return {
    to: token,
    data,
    value: '0',
    chainId: config.chain.chainId,
    description: `approve ${spender.slice(0, 6)}…${spender.slice(-4)}`,
  }
}

/** 后端广播签名后的 raw transaction;返回 txHash */
export async function broadcastSignedTx(serializedSignedTx: Hex): Promise<Hex> {
  return publicClient.sendRawTransaction({ serializedTransaction: serializedSignedTx })
}

// ============================================================
// 交易回执核实(sign-confirm 用):等回执 + 从 Swap 事件解析实际输出
// ============================================================

/** 等待交易回执;超时抛错 */
export async function waitForTxReceipt(txHash: Hex, timeoutMs = 90_000) {
  return publicClient.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs })
}

// Uniswap V2 Pair Swap 事件:Swap(address sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address to)
const SWAP_EVENT_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822' as Hex

export interface SwapAmountOut {
  amountOut: bigint
  /** 事件里的 token0/token1 输出(取决于交易对顺序,调用方按白名单代币方向选用) */
  amount0Out: bigint
  amount1Out: bigint
}

/**
 * 从交易回执的日志里解析 Swap 事件的实际输出数量。
 * V2 兑换只发生在一个交易对上,取最后一条 Swap 事件(有些 router 会走多跳,末跳的 to 才是最终接收者)。
 * 找不到 Swap 事件返回 null(调用方按 amountOut='0' 处理)。
 */
export function parseSwapAmountOut(receipt: { logs: { topics: unknown[]; data: Hex }[] }): SwapAmountOut | null {
  const swapLogs = receipt.logs.filter((l) => (l.topics[0] as Hex) === SWAP_EVENT_TOPIC)
  if (swapLogs.length === 0) return null
  const last = swapLogs[swapLogs.length - 1]
  // topics: [topic0, sender(indexed), to(indexed)];data: 4×uint256(amount0In, amount1In, amount0Out, amount1Out)
  const data = last.data.slice(2)
  const amount0Out = BigInt(`0x${data.slice(128, 192)}`)
  const amount1Out = BigInt(`0x${data.slice(192, 256)}`)
  return { amount0Out, amount1Out, amountOut: amount0Out > 0n ? amount0Out : amount1Out }
}
