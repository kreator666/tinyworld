import {
  createPublicClient,
  createWalletClient,
  http,
  isHex,
  formatUnits,
  encodeFunctionData,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia, avalancheFuji } from 'viem/chains'
import { config } from '../config'
import type { UnsignedTx } from './defi'

// ============================================================
// Aave v3 链交互(M4+):热钱包资金存入/取出赚供给收益(Supply APY)
// 合约地址来自 Aave 官方 address book(见 config.ts 注释)
// Fuji 支持原生 AVAX(WrappedTokenGateway)与 ERC20(USDC/WAVAX 直接 supply)
// ============================================================

const VIEM_CHAINS = { [sepolia.id]: sepolia, [avalancheFuji.id]: avalancheFuji } as const
const viemChain = VIEM_CHAINS[config.chain.chainId as keyof typeof VIEM_CHAINS] ?? sepolia

const publicClient = createPublicClient({ chain: viemChain, transport: http(config.chain.rpc) })

// Aave v3 Pool:getReserveData 返回完整 ReserveData,viem 解码需按结构体全量声明
const poolAbi = [
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        name: '',
        components: [
          { name: 'configuration', type: 'tuple', components: [{ name: 'data', type: 'uint256' }] },
          { name: 'liquidityIndex', type: 'uint128' },
          { name: 'currentLiquidityRate', type: 'uint128' },
          { name: 'variableBorrowIndex', type: 'uint128' },
          { name: 'currentVariableBorrowRate', type: 'uint128' },
          { name: 'currentStableBorrowRate', type: 'uint128' },
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'id', type: 'uint16' },
          { name: 'aTokenAddress', type: 'address' },
          { name: 'stableDebtTokenAddress', type: 'address' },
          { name: 'variableDebtTokenAddress', type: 'address' },
          { name: 'interestRateStrategyAddress', type: 'address' },
          { name: 'accruedToTreasury', type: 'uint128' },
          { name: 'unbacked', type: 'uint128' },
          { name: 'isolationModeTotalDebt', type: 'uint128' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'supply',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// WrappedTokenGateway:原生币存取(Fuji 上对应 AVAX)
const gatewayAbi = [
  {
    type: 'function',
    name: 'depositETH',
    stateMutability: 'payable',
    inputs: [
      { name: 'pool', type: 'address' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdrawETH',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'pool', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [],
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
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

/** RAY 精度:Aave 利率用 ray(1e27 = 100%)表示 */
const RAY = 10n ** 27n

/** 链上原生 AVAX 存取网关(Aave 官方 address book: WETH_GATEWAY) */
export const NATIVE_GATEWAY: Address = '0x3d2ee1AB8C3a597cDf80273C684dE0036481bE3a'

function agentAccount() {
  const key = config.agentPrivateKey
  if (!key || !isHex(key)) return null
  return privateKeyToAccount(key as Hex)
}

/** 热钱包地址;未配置 AGENT_PRIVATE_KEY 返回 null */
export function getLendingWalletAddress(): Address | null {
  return agentAccount()?.address ?? null
}

export interface ReserveInfo {
  aToken: Address
  /** 供给端年化(APY,小数形式如 0.0321 = 3.21%),来自 currentLiquidityRate */
  supplyApy: number
}

/** 读取资产的 aToken 地址与当前供给 APY */
export async function getReserveInfo(asset: Address): Promise<ReserveInfo> {
  const data = (await publicClient.readContract({
    address: config.chain.aave!.pool,
    abi: poolAbi,
    functionName: 'getReserveData',
    args: [asset],
  })) as {
    aTokenAddress: Address
    currentLiquidityRate: bigint
  }
  return {
    aToken: data.aTokenAddress,
    supplyApy: Number(data.currentLiquidityRate) / Number(RAY),
  }
}

/** aToken 余额(= 用户在 Aave 的存款本金+利息,最小单位) */
export async function getATokenBalance(aToken: Address, user: Address): Promise<bigint> {
  return (await publicClient.readContract({
    address: aToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [user],
  })) as bigint
}

/** ERC20 授权额度 */
export async function getTokenAllowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  return (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })) as bigint
}

export interface LendingResult {
  txHash: Hex
  /** 实际变化量(存款=aToken增长;取款=底层币到账),防"假成功" */
  delta: bigint
}

/** ERC20 存入 Aave:approve(不足才发)→ supply → 核实 aToken 余额真实增长 */
export async function supplyErc20(asset: Address, amount: bigint): Promise<LendingResult> {
  const account = agentAccount()
  if (!account) throw new Error('未配置执行密钥(AGENT_PRIVATE_KEY)')
  const wallet = createWalletClient({ account, chain: viemChain, transport: http(config.chain.rpc) })
  const pool = config.chain.aave!.pool

  const info = await getReserveInfo(asset)
  const before = await getATokenBalance(info.aToken, account.address)

  if ((await getTokenAllowance(asset, account.address, pool)) < amount) {
    const t0 = await wallet.writeContract({
      address: asset,
      abi: erc20Abi,
      functionName: 'approve',
      args: [pool, amount],
    })
    const r0 = await publicClient.waitForTransactionReceipt({ hash: t0, timeout: 120_000 })
    if (r0.status !== 'success') throw new Error(`approve(Pool) 失败: ${t0}`)
  }

  const tx = await wallet.writeContract({
    address: pool,
    abi: poolAbi,
    functionName: 'supply',
    args: [asset, amount, account.address, 0],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error(`supply 执行失败(revert): ${tx}`)

  const after = await getATokenBalance(info.aToken, account.address)
  const delta = after - before
  if (delta < amount) throw new Error(`交易成功但 aToken 增长不足(假成功): ${tx}`)
  return { txHash: tx, delta }
}

/** 原生币(如 AVAX)经 Gateway 存入 Aave → 核实 aWAVAX 余额真实增长 */
export async function supplyNative(amount: bigint): Promise<LendingResult> {
  const account = agentAccount()
  if (!account) throw new Error('未配置执行密钥(AGENT_PRIVATE_KEY)')
  const wallet = createWalletClient({ account, chain: viemChain, transport: http(config.chain.rpc) })

  const info = await getReserveInfo(config.chain.defi!.wNative)
  const before = await getATokenBalance(info.aToken, account.address)

  const tx = await wallet.writeContract({
    address: NATIVE_GATEWAY,
    abi: gatewayAbi,
    functionName: 'depositETH',
    args: [config.chain.aave!.pool, account.address, 0],
    value: amount,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error(`depositETH 执行失败(revert): ${tx}`)

  const after = await getATokenBalance(info.aToken, account.address)
  const delta = after - before
  if (delta < amount) throw new Error(`交易成功但 aToken 增长不足(假成功): ${tx}`)
  return { txHash: tx, delta }
}

/** 从 Aave 取出 ERC20 → 核实底层币到账 */
export async function withdrawErc20(asset: Address, amount: bigint): Promise<LendingResult> {
  const account = agentAccount()
  if (!account) throw new Error('未配置执行密钥(AGENT_PRIVATE_KEY)')
  const wallet = createWalletClient({ account, chain: viemChain, transport: http(config.chain.rpc) })

  const erc20Before = (await publicClient.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint

  const tx = await wallet.writeContract({
    address: config.chain.aave!.pool,
    abi: poolAbi,
    functionName: 'withdraw',
    args: [asset, amount, account.address],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error(`withdraw 执行失败(revert): ${tx}`)

  const erc20After = (await publicClient.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint
  const delta = erc20After - erc20Before
  if (delta < amount) throw new Error(`交易成功但底层币到账不足(假成功): ${tx}`)
  return { txHash: tx, delta }
}

/** 从 Aave 取回原生币(经 Gateway)→ 核实原生余额真实增长(gas 扣在同一余额,要加回来) */
export async function withdrawNative(amount: bigint): Promise<LendingResult> {
  const account = agentAccount()
  if (!account) throw new Error('未配置执行密钥(AGENT_PRIVATE_KEY)')
  const wallet = createWalletClient({ account, chain: viemChain, transport: http(config.chain.rpc) })

  // 网关 withdrawETH 会 transferFrom 用户的 aToken,必须先授权 aToken 给网关
  const info = await getReserveInfo(config.chain.defi!.wNative)
  if ((await getTokenAllowance(info.aToken, account.address, NATIVE_GATEWAY)) < amount) {
    const t0 = await wallet.writeContract({
      address: info.aToken,
      abi: erc20Abi,
      functionName: 'approve',
      args: [NATIVE_GATEWAY, amount],
    })
    const r0 = await publicClient.waitForTransactionReceipt({ hash: t0, timeout: 120_000 })
    if (r0.status !== 'success') throw new Error(`approve(aToken→Gateway) 失败: ${t0}`)
  }

  const before = await publicClient.getBalance({ address: account.address })
  const tx = await wallet.writeContract({
    address: NATIVE_GATEWAY,
    abi: gatewayAbi,
    functionName: 'withdrawETH',
    args: [config.chain.aave!.pool, amount, account.address],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error(`withdrawETH 执行失败(revert): ${tx}`)

  const after = await publicClient.getBalance({ address: account.address })
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice
  const delta = after - before + gasCost
  if (delta < amount) throw new Error(`交易成功但原生币到账不足(假成功): ${tx}`)
  return { txHash: tx, delta }
}

/** 只读:无需私钥 */
export const aavePublicClient = publicClient

/** 金额格式化辅助 */
export { formatUnits }

// ============================================================
// 用户钱包签名模式(M4+):Agent 只组装 unsigned tx,前端钱包签名
// 存款:ERC20 需 approve+supply 两笔;原生币 depositETH 一笔(payable)
// 取款:ERC20 pool.withdraw 一笔即可(直接烧调用者的 aToken,无需 approve);
//      原生币走网关 withdrawETH,但需先把 aToken approve 给网关(两笔)
// ============================================================

/** 组装 ERC20 存入 Aave 的 unsigned supply(授权检查由调用方先做完) */
export function buildUnsignedSupply(asset: Address, amount: bigint, onBehalfOf: Address): UnsignedTx {
  const data = encodeFunctionData({
    abi: poolAbi,
    functionName: 'supply',
    args: [asset, amount, onBehalfOf, 0],
  })
  return {
    to: config.chain.aave!.pool,
    data,
    value: '0',
    chainId: config.chain.chainId,
    description: `存入 Aave ${asset.slice(0, 6)}…${asset.slice(-4)}`,
  }
}

/** 组装原生币存入 Aave 的 unsigned depositETH(经 Gateway,payable) */
export function buildUnsignedNativeSupply(amount: bigint, onBehalfOf: Address): UnsignedTx {
  const data = encodeFunctionData({
    abi: gatewayAbi,
    functionName: 'depositETH',
    args: [config.chain.aave!.pool, onBehalfOf, 0],
  })
  return {
    to: NATIVE_GATEWAY,
    data,
    value: amount.toString(),
    chainId: config.chain.chainId,
    description: `存入 Aave ${config.chain.defi!.nativeSymbol}`,
  }
}

/** 组装 ERC20 取回的 unsigned withdraw(用户直接收 ERC20,无需授权) */
export function buildUnsignedWithdraw(asset: Address, amount: bigint, to: Address): UnsignedTx {
  const data = encodeFunctionData({
    abi: poolAbi,
    functionName: 'withdraw',
    args: [asset, amount, to],
  })
  return {
    to: config.chain.aave!.pool,
    data,
    value: '0',
    chainId: config.chain.chainId,
    description: `从 Aave 取回 ${asset.slice(0, 6)}…${asset.slice(-4)}`,
  }
}

/** 组装原生币取回的 unsigned withdrawETH(经 Gateway;调用方需先组装 aToken approve) */
export function buildUnsignedNativeWithdraw(amount: bigint, to: Address): UnsignedTx {
  const data = encodeFunctionData({
    abi: gatewayAbi,
    functionName: 'withdrawETH',
    args: [config.chain.aave!.pool, amount, to],
  })
  return {
    to: NATIVE_GATEWAY,
    data,
    value: '0',
    chainId: config.chain.chainId,
    description: `从 Aave 取回 ${config.chain.defi!.nativeSymbol}`,
  }
}
