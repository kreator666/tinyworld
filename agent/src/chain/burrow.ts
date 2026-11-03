import { getChainContext } from './registry'
import { nearAgentAccountId, nearCall, nearView, ensureStorageDeposit } from './nearWrite'
import { refToken, refTokenDecimals } from './ref'

// ============================================================
// Burrow 借贷(NEAR 家族,defi-lending-burrow 技能用;testnet 合约实测存活,见
// knowledge/near-defi-integration-plan.md)。仅 hot_wallet 模式。
// - 存款(生息/作抵押):NEP-141 ft_transfer_call(msg "Supply");取回 execute Withdraw
// - 借款 execute Borrow / 还款 ft_transfer_call(msg "Repay"),金额用代币人类单位(decimal 字符串)
// - 前置:热钱包在 burrow 合约的 NEP-145 storage deposit(ensureStorageDeposit 幂等注册)
// 依赖 Ref 测试网代币表(chain/ref.ts REF_TESTNET_TOKENS)作为可存借资产清单。
// ============================================================

export function burrowContract(chainKey: string): string {
  const addr = getChainContext(chainKey).cfg.near?.burrow
  if (!addr) throw new Error(`[${chainKey}] 未配置 Burrow 合约(cfg.near.burrow)`)
  return addr
}

export interface BurrowAssetView {
  token_id: string
  balance?: string
  account_balance?: string
  shares?: string
  apr?: string
}

export interface BurrowAccountView {
  account_id?: string
  supplied: BurrowAssetView[]
  collateral: BurrowAssetView[]
  borrowed: BurrowAssetView[]
  borrow_power?: string
  health_factor?: string
}

/** 账户仓位视图(未注册返回 null) */
export async function burrowGetAccount(chainKey: string, accountId?: string): Promise<BurrowAccountView | null> {
  return nearView<BurrowAccountView>(chainKey, burrowContract(chainKey), 'get_account', { account_id: accountId ?? nearAgentAccountId() })
}

/** 存款:ft_transfer_call(空 msg = 存入生息);测试网 fakes 用原子单位字符串金额 */
export async function burrowSupply(chainKey: string, tokenSymbol: string, amountAtomic: string): Promise<string> {
  const burrow = burrowContract(chainKey)
  const token = refToken(chainKey, tokenSymbol)
  await ensureStorageDeposit(chainKey, burrow)
  return nearCall(chainKey, token.contractId, 'ft_transfer_call', { receiver_id: burrow, amount: amountAtomic, msg: '' }, 1n)
}

/** 借款;amount 为代币人类单位(如 "10.5"),合约按 ft_metadata 小数位解析 */
export async function burrowBorrow(chainKey: string, tokenSymbol: string, amountHuman: string): Promise<string> {
  const burrow = burrowContract(chainKey)
  const token = refToken(chainKey, tokenSymbol)
  await ensureStorageDeposit(chainKey, burrow)
  return nearCall(chainKey, burrow, 'execute', { actions: [{ Borrow: { token_id: token.contractId, amount: amountHuman } }] })
}

/** 还款:execute Repay(从 Burrow 账户的存款余额中扣,无需再转代币) */
export async function burrowRepay(chainKey: string, tokenSymbol: string, amountHuman: string): Promise<string> {
  const burrow = burrowContract(chainKey)
  const token = refToken(chainKey, tokenSymbol)
  return nearCall(chainKey, burrow, 'execute', { actions: [{ Repay: { token_id: token.contractId, amount: amountHuman } }] })
}

/** 取回存款;amountHuman 传 null 表示全部取出 */
export async function burrowWithdraw(chainKey: string, tokenSymbol: string, amountHuman: string | null): Promise<string> {
  const burrow = burrowContract(chainKey)
  const token = refToken(chainKey, tokenSymbol)
  const action: Record<string, unknown> = { Withdraw: { token_id: token.contractId } }
  if (amountHuman !== null) (action.Withdraw as Record<string, unknown>).amount = amountHuman
  else (action.Withdraw as Record<string, unknown>).max_amount = '0' // 0 = 全部(burrow 约定)
  return nearCall(chainKey, burrow, 'execute', { actions: [action] })
}

/** 代币符号 → 人类单位字符串(原子单位换算,技能层用) */
export async function burrowToHuman(chainKey: string, tokenSymbol: string, amountAtomic: string): Promise<string> {
  const token = refToken(chainKey, tokenSymbol)
  const decimals = await refTokenDecimals(chainKey, token.contractId)
  return (Number(amountAtomic) / 10 ** decimals).toFixed(6)
}

export async function burrowToAtomic(chainKey: string, tokenSymbol: string, amountHuman: string): Promise<string> {
  const token = refToken(chainKey, tokenSymbol)
  const decimals = await refTokenDecimals(chainKey, token.contractId)
  return BigInt(Math.round(parseFloat(amountHuman) * 10 ** decimals)).toString()
}
