import { config } from '../config'
import { getChainContext } from './registry'
import { nearAgentAccountId, nearCall, nearView } from './nearWrite'
import { burrowGetAccount, burrowSupply } from './burrow'

// ============================================================
// Meta Pool 流动质押(生存模式垫资用,仅 near-mainnet):
// - stakeNear:deposit_and_stake(payable)铸 stNEAR,热钱包持有
// - stNearPrice:get_st_near_price 返回每 stNEAR 的 NEAR 数量(1e24 精度定点小数)
// near-testnet 无 Meta Pool 部署,用 Burrow supply wNEAR 作质押替身(接口形状相同,
// 收益快照按 1:1 计价);由 isTestnet(chainKey) 分发。
// ============================================================

const STNEAR_PRICE_SCALE = 10n ** 24n // get_st_near_price 为 1e24 精度的定点小数

function isTestnet(chainKey: string): boolean {
  return getChainContext(chainKey).cfg.chainId === 398
}

function metaPoolContract(chainKey: string): string {
  if (isTestnet(chainKey)) throw new Error(`[${chainKey}] Meta Pool 仅主网可用,测试网应走 Burrow 替身`)
  return config.survivalMetaPoolContract
}

/**
 * 垫资质押:主网 meta-pool.near deposit_and_stake;测试网 Burrow 存 wNEAR(替身)。
 * 返回交易哈希。资金安全:目标合约固定为上述两个地址,不允许外部传入。
 */
export async function stakeNear(chainKey: string, yoctoAmount: string): Promise<{ txHash: string }> {
  if (BigInt(yoctoAmount) <= 0n) throw new Error('质押金额必须大于 0')
  if (isTestnet(chainKey)) {
    // 测试网替身:Burrow supply wNEAR(wrap.testnet);native NEAR 需先包裹,由 ref 侧逻辑保证余额
    const txHash = await burrowSupply(chainKey, 'WNEAR', yoctoAmount)
    return { txHash }
  }
  const txHash = await nearCall(chainKey, metaPoolContract(chainKey), 'deposit_and_stake', {}, yoctoAmount)
  return { txHash }
}

/** stNEAR 余额(最小单位字符串);测试网替身返回 Burrow 已存 wNEAR 余额 */
export async function stNearBalance(chainKey: string, accountId?: string): Promise<string> {
  const me = accountId ?? nearAgentAccountId()
  if (isTestnet(chainKey)) {
    const acct = await burrowGetAccount(chainKey, me)
    const wnear = acct?.supplied?.find((a) => a.token_id === 'wrap.testnet')
    return wnear?.balance ?? wnear?.account_balance ?? '0'
  }
  const bal = await nearView<string>(chainKey, metaPoolContract(chainKey), 'ft_balance_of', { account_id: me })
  return bal ?? '0'
}

/** stNEAR 对 NEAR 价(每 1 stNEAR 值多少 yocto NEAR,字符串);测试网替身固定 1:1 */
export async function stNearPrice(chainKey: string): Promise<string> {
  if (isTestnet(chainKey)) return STNEAR_PRICE_SCALE.toString()
  const price = await nearView<string>(chainKey, metaPoolContract(chainKey), 'get_st_near_price', {})
  if (price === null) throw new Error('Meta Pool get_st_near_price 返回空')
  return price
}

/** 账户质押总价值(yocto NEAR)= 余额 × stNEAR 价 / 1e24 */
export async function totalStakedValueYocto(chainKey: string, accountId?: string): Promise<bigint> {
  const [bal, price] = await Promise.all([stNearBalance(chainKey, accountId), stNearPrice(chainKey)])
  return (BigInt(bal) * BigInt(price)) / STNEAR_PRICE_SCALE
}
