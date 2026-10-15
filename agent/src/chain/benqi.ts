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
// 赎回机制:redeem(shares) 后进入 15 天冷却(cooldownPeriod=1296000 秒,期间奖励照算),
// 冷却结束后 2 天领取窗口内 claim() 取回 AVAX,过期需重新赎回
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
    name: 'submit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'shareAmount', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
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

/** 组装赎回交易(v2 用:v1 不暴露 unstake 工具;赎回为 ticket+claim 两段式,含 15 天冷却) */
export function buildUnsignedUnstake(chainKey: string, shares: bigint): UnsignedTx {
  const benqi = benqiCfg(chainKey)
  return {
    to: benqi.staking as Address,
    data: encodeFunctionData({ abi: stakingAbi, functionName: 'redeem', args: [shares] }),
    value: '0',
    chainId: getChainContext(chainKey).cfg.chainId,
    description: '赎回 sAVAX → AVAX(BENQI,进入 15 天冷却)',
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
