import { encodeFunctionData, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { config } from '../config'
import { getChainContext } from './registry'
import { getPublicClient, getWalletClient } from './clients'
import { getTokenBalance, type UnsignedTx } from './defi'

// ============================================================
// BENQI Liquid Staking 链交互:AVAX → sAVAX(主网专属)
// 合约是双用途的:sAVAX 代币合约即质押合约(submit() payable 铸 sAVAX,redeem() 生成赎回 ticket)
// 地址核实(2026-10):官方文档 https://docs.benqi.fi/resources/contracts/liquid-staking.md
// + 主网 RPC 自证(name/symbol/decimals、getPooledAvaxByShares 汇率>1、cooldownPeriod=15 天、totalPooledAvax≈2300 万 AVAX)
// 赎回机制(基于官方合约):
// 1. requestUnlock(shareAmount) 发起赎回,sAVAX 转入合约托管,进入 cooldownPeriod(约 15 天)冷却;
// 2. 冷却结束后 redeem() 或 redeem(unlockIndex) 在 redeemPeriod(约 2 天)领取窗口内取回 AVAX;
// 3. 错过领取窗口则 redeemOverdueShares() 退回 sAVAX,需重新 requestUnlock。
// ============================================================

const stakingAbi = [
  {
    type: 'function',
    name: 'getPooledAvaxByShares',
    stateMutability: 'view',
    inputs: [{ name: 'shareAmount', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getSharesByPooledAvax',
    stateMutability: 'view',
    inputs: [{ name: 'avaxAmount', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'cooldownPeriod',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'redeemPeriod',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'submit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'requestUnlock',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'shareAmount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'unlockIndex', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'redeemOverdueShares',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'redeemOverdueShares',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'unlockIndex', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getUnlockRequestCount',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getPaginatedUnlockRequests',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'from', type: 'uint256' },
      { name: 'to', type: 'uint256' },
    ],
    outputs: [
      {
        name: 'requests',
        type: 'tuple[]',
        components: [
          { name: 'startedAt', type: 'uint256' },
          { name: 'shareAmount', type: 'uint256' },
        ],
      },
      { name: 'exchangeRates', type: 'uint256[]' },
    ],
  },
] as const

const erc20BalanceAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/** 链的 BENQI 配置;未配置(如 Fuji)直接抛错 */
export function benqiCfg(chainKey: string) {
  const cfg = getChainContext(chainKey).cfg
  if (!cfg.benqi) throw new Error(`链 ${cfg.name} 未配置 BENQI Liquid Staking(仅 Avalanche 主网)`)
  return cfg.benqi
}

/** 热钱包客户端(AGENT_PRIVATE_KEY 单钥多链);未配置返回 null */
function hotWallet(chainKey: string) {
  if (!config.agentPrivateKey) return null
  return getWalletClient(chainKey, config.agentPrivateKey as Hex)
}

export function getStakingWalletAddress(): Address | null {
  if (!config.agentPrivateKey) return null
  return privateKeyToAccount(config.agentPrivateKey as Hex).address
}

/** 质押基本信息:汇率 + 指定地址的 sAVAX 余额(及折 AVAX) */
export interface StakingInfo {
  /** 1 sAVAX 可赎回的 AVAX(随质押奖励累积,>1) */
  avaxPerSavax: string
  /** 1 AVAX 当前可换得的 sAVAX */
  savaxPerAvax: string
  /** 冷却期(秒)与展示用天数 */
  cooldownSeconds: number
  cooldownDays: number
  sAvaxBalance: bigint
  sAvaxBalanceInAvax: string
}

export async function fetchStakingInfo(chainKey: string, address: Address): Promise<StakingInfo> {
  const benqi = benqiCfg(chainKey)
  const client = getPublicClient(chainKey)
  const E18 = 10n ** 18n
  const [pooledPerShare, sharesPerAvax, cooldown, sAvaxBalance] = await Promise.all([
    client.readContract({ address: benqi.sAvax as Address, abi: stakingAbi, functionName: 'getPooledAvaxByShares', args: [E18] }) as Promise<bigint>,
    client.readContract({ address: benqi.staking as Address, abi: stakingAbi, functionName: 'getSharesByPooledAvax', args: [E18] }) as Promise<bigint>,
    client.readContract({ address: benqi.staking as Address, abi: stakingAbi, functionName: 'cooldownPeriod' }) as Promise<bigint>,
    getTokenBalance(chainKey, benqi.sAvax as Address, address),
  ])
  const inAvax = (sAvaxBalance * pooledPerShare) / E18
  return {
    avaxPerSavax: formatUnit(pooledPerShare),
    savaxPerAvax: formatUnit(sharesPerAvax),
    cooldownSeconds: Number(cooldown),
    cooldownDays: Number(cooldown) / 86400,
    sAvaxBalance,
    sAvaxBalanceInAvax: formatUnit(inAvax),
  }
}

/** 报价:amountAvax(wei) 预计可得 sAVAX(shares) */
export async function quoteStake(chainKey: string, amountAvax: bigint): Promise<bigint> {
  const benqi = benqiCfg(chainKey)
  return (await getPublicClient(chainKey).readContract({
    address: benqi.staking as Address,
    abi: stakingAbi,
    functionName: 'getSharesByPooledAvax',
    args: [amountAvax],
  })) as bigint
}

// 18 位小数的轻量格式化(避免引入整个 viem formatEther 到调用面也行,这里直接用)
function formatUnit(v: bigint, decimals = 18): string {
  const s = v.toString().padStart(decimals + 1, '0')
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, '')
}

// ============================================================
// 交易组装(user_wallet 签名模式)
// ============================================================

/** 组装质押交易(用户钱包签名用) */
export function buildUnsignedStake(chainKey: string, amountAvax: bigint): UnsignedTx {
  const benqi = benqiCfg(chainKey)
  return {
    to: benqi.staking as Address,
    data: encodeFunctionData({ abi: stakingAbi, functionName: 'submit', args: [] }),
    value: amountAvax.toString(),
    chainId: getChainContext(chainKey).cfg.chainId,
    description: '质押 AVAX → sAVAX(BENQI)',
  }
}

/** 组装发起赎回交易:requestUnlock(shares) 进入冷却期 */
export function buildUnsignedRequestUnlock(chainKey: string, shares: bigint): UnsignedTx {
  const benqi = benqiCfg(chainKey)
  return {
    to: benqi.staking as Address,
    data: encodeFunctionData({ abi: stakingAbi, functionName: 'requestUnlock', args: [shares] }),
    value: '0',
    chainId: getChainContext(chainKey).cfg.chainId,
    description: '发起 BENQI 赎回,15 天冷却后开始可领 AVAX',
  }
}

/** 组装领取已到期赎回交易:redeem() 领取所有可领 AVAX */
export function buildUnsignedRedeem(chainKey: string, unlockIndex?: bigint): UnsignedTx {
  const benqi = benqiCfg(chainKey)
  return {
    to: benqi.staking as Address,
    data: encodeFunctionData({
      abi: stakingAbi,
      functionName: 'redeem',
      args: unlockIndex !== undefined ? [unlockIndex] : [],
    }),
    value: '0',
    chainId: getChainContext(chainKey).cfg.chainId,
    description: '领取 BENQI 赎回 AVAX',
  }
}

/** 组装退回过期赎回交易:redeemOverdueShares() 取回 sAVAX */
export function buildUnsignedRedeemOverdueShares(chainKey: string, unlockIndex?: bigint): UnsignedTx {
  const benqi = benqiCfg(chainKey)
  return {
    to: benqi.staking as Address,
    data: encodeFunctionData({
      abi: stakingAbi,
      functionName: 'redeemOverdueShares',
      args: unlockIndex !== undefined ? [unlockIndex] : [],
    }),
    value: '0',
    chainId: getChainContext(chainKey).cfg.chainId,
    description: 'BENQI 赎回已过期,退回 sAVAX',
  }
}

// ============================================================
// 执行(hot_wallet 自动模式)
// ============================================================

export interface StakeResult {
  txHash: Hex
  sAvaxOut: bigint // 实际到账 sAVAX(余额差核实,防"假成功")
}

/**
 * 热钱包执行质押:submit() payable → 等回执 → status 校验 → sAVAX 余额差核实
 * 余额没增长视为失败(抛错),与 chain/defi.ts 防假成功口径一致
 */
export async function executeStake(chainKey: string, amountAvax: bigint): Promise<StakeResult> {
  const benqi = benqiCfg(chainKey)
  const wallet = hotWallet(chainKey)
  if (!wallet) throw new Error('未配置执行密钥(AGENT_PRIVATE_KEY)')
  const account = wallet.account!
  const client = getPublicClient(chainKey)

  const before = await getTokenBalance(chainKey, benqi.sAvax as Address, account.address)
  const txHash = await wallet.writeContract({
    address: benqi.staking as Address,
    abi: stakingAbi,
    functionName: 'submit',
    value: amountAvax,
  })
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
  if (receipt.status !== 'success') {
    throw new Error(`质押交易上链但执行失败(revert): ${txHash}`)
  }
  const after = await getTokenBalance(chainKey, benqi.sAvax as Address, account.address)
  const sAvaxOut = after - before
  if (sAvaxOut <= 0n) {
    throw new Error(`质押交易成功但 sAVAX 余额未增长(假成功): ${txHash}`)
  }
  return { txHash, sAvaxOut }
}

// ============================================================
// 赎回相关类型与查询
// ============================================================

export interface UnlockRequest {
  index: number
  startedAt: bigint
  shareAmount: bigint
  exchangeRate?: bigint
}

export type UnlockStatus = 'cooling' | 'claimable' | 'expired'

export interface UnlockRequestWithStatus extends UnlockRequest {
  status: UnlockStatus
  claimableAt: Date
  expiresAt: Date
}

export interface UnlockPeriods {
  cooldownSeconds: bigint
  redeemSeconds: bigint
}

/** 读取冷却期与领取窗口 */
export async function fetchUnlockPeriods(chainKey: string): Promise<UnlockPeriods> {
  const benqi = benqiCfg(chainKey)
  const client = getPublicClient(chainKey)
  const [cooldownSeconds, redeemSeconds] = await Promise.all([
    client.readContract({ address: benqi.staking as Address, abi: stakingAbi, functionName: 'cooldownPeriod' }) as Promise<bigint>,
    client.readContract({ address: benqi.staking as Address, abi: stakingAbi, functionName: 'redeemPeriod' }) as Promise<bigint>,
  ])
  return { cooldownSeconds, redeemSeconds }
}

/** 查询用户所有 unlock 请求,并标注 cooling/claimable/expired 状态 */
export async function fetchUnlockRequests(
  chainKey: string,
  user: Address,
): Promise<UnlockRequestWithStatus[]> {
  const benqi = benqiCfg(chainKey)
  const client = getPublicClient(chainKey)
  const { cooldownSeconds, redeemSeconds } = await fetchUnlockPeriods(chainKey)

  const count = (await client.readContract({
    address: benqi.staking as Address,
    abi: stakingAbi,
    functionName: 'getUnlockRequestCount',
    args: [user],
  })) as bigint

  if (count === 0n) return []

  const [requests, exchangeRates] = (await client.readContract({
    address: benqi.staking as Address,
    abi: stakingAbi,
    functionName: 'getPaginatedUnlockRequests',
    args: [user, 0n, count],
  })) as [{ startedAt: bigint; shareAmount: bigint }[], bigint[]]

  const now = BigInt(Math.floor(Date.now() / 1000))
  return requests.map((r, i) => {
    const claimableAt = r.startedAt + cooldownSeconds
    const expiresAt = claimableAt + redeemSeconds
    let status: UnlockStatus
    if (now < claimableAt) status = 'cooling'
    else if (now < expiresAt) status = 'claimable'
    else status = 'expired'
    return {
      index: i,
      startedAt: r.startedAt,
      shareAmount: r.shareAmount,
      exchangeRate: exchangeRates[i] && exchangeRates[i] > 0n ? exchangeRates[i] : undefined,
      status,
      claimableAt: new Date(Number(claimableAt) * 1000),
      expiresAt: new Date(Number(expiresAt) * 1000),
    }
  })
}

/** 计算可领取的 sAVAX 份额与过期份额 */
export function classifyUnlockRequests(requests: UnlockRequestWithStatus[]) {
  const claimable = requests.filter((r) => r.status === 'claimable')
  const expired = requests.filter((r) => r.status === 'expired')
  const cooling = requests.filter((r) => r.status === 'cooling')
  const claimableShares = claimable.reduce((sum, r) => sum + r.shareAmount, 0n)
  const expiredShares = expired.reduce((sum, r) => sum + r.shareAmount, 0n)
  return { claimable, expired, cooling, claimableShares, expiredShares }
}

// ============================================================
// 赎回执行(hot_wallet 自动模式)
// ============================================================

export interface RequestUnlockResult {
  txHash: Hex
  sharesLocked: bigint
}

/** 热钱包执行 requestUnlock:把 sAVAX 锁进合约进入冷却 */
export async function executeRequestUnlock(chainKey: string, shares: bigint): Promise<RequestUnlockResult> {
  const benqi = benqiCfg(chainKey)
  const wallet = hotWallet(chainKey)
  if (!wallet) throw new Error('未配置执行密钥(AGENT_PRIVATE_KEY)')
  const account = wallet.account!
  const client = getPublicClient(chainKey)

  const balance = await getTokenBalance(chainKey, benqi.sAvax as Address, account.address)
  if (balance < shares) throw new Error(`sAVAX 余额不足:需 ${shares},有 ${balance}`)

  const before = (await client.readContract({
    address: benqi.staking as Address,
    abi: stakingAbi,
    functionName: 'getUnlockRequestCount',
    args: [account.address],
  })) as bigint

  const txHash = await wallet.writeContract({
    address: benqi.staking as Address,
    abi: stakingAbi,
    functionName: 'requestUnlock',
    args: [shares],
  })
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
  if (receipt.status !== 'success') {
    throw new Error(`发起赎回交易上链但执行失败(revert): ${txHash}`)
  }

  const after = (await client.readContract({
    address: benqi.staking as Address,
    abi: stakingAbi,
    functionName: 'getUnlockRequestCount',
    args: [account.address],
  })) as bigint
  if (after <= before) {
    throw new Error(`发起赎回成功但请求数未增长(假成功): ${txHash}`)
  }
  return { txHash, sharesLocked: shares }
}

export interface RedeemResult {
  txHash: Hex
  avaxOut: bigint
}

/** 热钱包执行 redeem:领取所有可领取的 AVAX */
export async function executeRedeem(chainKey: string): Promise<RedeemResult> {
  const benqi = benqiCfg(chainKey)
  const wallet = hotWallet(chainKey)
  if (!wallet) throw new Error('未配置执行密钥(AGENT_PRIVATE_KEY)')
  const account = wallet.account!
  const client = getPublicClient(chainKey)

  const requests = await fetchUnlockRequests(chainKey, account.address)
  const { claimable, claimableShares } = classifyUnlockRequests(requests)
  if (claimableShares <= 0n) throw new Error('当前没有可领取的 BENQI 赎回')

  const before = await client.getBalance({ address: account.address })
  const txHash = await wallet.writeContract({
    address: benqi.staking as Address,
    abi: stakingAbi,
    functionName: 'redeem',
    args: [],
  })
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
  if (receipt.status !== 'success') {
    throw new Error(`领取赎回交易上链但执行失败(revert): ${txHash}`)
  }

  const after = await client.getBalance({ address: account.address })
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice
  const avaxOut = after - before + gasCost
  if (avaxOut <= 0n) {
    throw new Error(`领取赎回成功但 AVAX 余额未增长(假成功): ${txHash}`)
  }
  return { txHash, avaxOut }
}

export interface RedeemOverdueResult {
  txHash: Hex
  sharesReturned: bigint
}

/** 热钱包执行 redeemOverdueShares:把过期的 sAVAX 取回 */
export async function executeRedeemOverdueShares(chainKey: string): Promise<RedeemOverdueResult> {
  const benqi = benqiCfg(chainKey)
  const wallet = hotWallet(chainKey)
  if (!wallet) throw new Error('未配置执行密钥(AGENT_PRIVATE_KEY)')
  const account = wallet.account!
  const client = getPublicClient(chainKey)

  const requests = await fetchUnlockRequests(chainKey, account.address)
  const { expired, expiredShares } = classifyUnlockRequests(requests)
  if (expiredShares <= 0n) throw new Error('当前没有过期的 BENQI 赎回可退回')

  const before = await getTokenBalance(chainKey, benqi.sAvax as Address, account.address)
  const txHash = await wallet.writeContract({
    address: benqi.staking as Address,
    abi: stakingAbi,
    functionName: 'redeemOverdueShares',
    args: [],
  })
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
  if (receipt.status !== 'success') {
    throw new Error(`退回过期赎回交易上链但执行失败(revert): ${txHash}`)
  }

  const after = await getTokenBalance(chainKey, benqi.sAvax as Address, account.address)
  const sharesReturned = after - before
  if (sharesReturned <= 0n) {
    throw new Error(`退回过期赎回成功但 sAVAX 余额未增长(假成功): ${txHash}`)
  }
  return { txHash, sharesReturned }
}
