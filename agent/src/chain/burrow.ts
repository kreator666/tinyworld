import { getChainContext } from './registry'
import { nearAgentAccountId, nearCall, nearView, ensureStorageDeposit, nearStorageBalance, NEAR_TX_GAS, DEFAULT_STORAGE_DEPOSIT, type NearUnsignedTx } from './nearWrite'
import { refToken, refTokenDecimals, refTokens } from './ref'

// ============================================================
// Burrow 借贷(NEAR 家族,defi-lending-burrow 技能用;testnet 合约实测存活,见
// knowledge/near-defi-integration-plan.md)。两种模式:
// - hot_wallet:burrowSupply/Borrow/Repay/Withdraw 热钱包直发;
// - user_wallet:buildBurrow*Txs 只组装交易,主人钱包逐笔签名
// - 存款(生息/作抵押):NEP-141 ft_transfer_call(msg "Supply");取回 execute Withdraw
// - 借款 execute Borrow / 还款 execute Repay,金额用代币人类单位(decimal 字符串)
// - 前置:交易方在 burrow 合约的 NEP-145 storage deposit(未注册时需先付可退押金)
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
  return nearView<BurrowAccountView>(chainKey, burrowContract(chainKey), 'get_account', { account_id: accountId ?? nearAgentAccountId(chainKey) })
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
  return nearCall(chainKey, burrow, 'execute', { actions: [{ Borrow: { token_id: token.contractId, amount: amountHuman } }] }, 1n)
}

/** 还款:execute Repay(从 Burrow 账户的存款余额中扣,无需再转代币) */
export async function burrowRepay(chainKey: string, tokenSymbol: string, amountHuman: string): Promise<string> {
  const burrow = burrowContract(chainKey)
  const token = refToken(chainKey, tokenSymbol)
  return nearCall(chainKey, burrow, 'execute', { actions: [{ Repay: { token_id: token.contractId, amount: amountHuman } }] }, 1n)
}

/** 取回存款;amountHuman 传 null 表示全部取出(burrow 约定:不带 amount/max_amount 即全取) */
export async function burrowWithdraw(chainKey: string, tokenSymbol: string, amountHuman: string | null): Promise<string> {
  const burrow = burrowContract(chainKey)
  const token = refToken(chainKey, tokenSymbol)
  const action: Record<string, unknown> = { Withdraw: { token_id: token.contractId } }
  if (amountHuman !== null) (action.Withdraw as Record<string, unknown>).amount = amountHuman
  return nearCall(chainKey, burrow, 'execute', { actions: [action] }, 1n)
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

// ============================================================
// user_wallet 模式的交易组装(只组装不发交易,与 hot 路径同判据):
// 存款 = storage_deposit(按需) + ft_transfer_call;借/还/取 = burrow 合约 execute 一笔。
// ============================================================

/** burrow 合约 storage 未注册时的注册交易(0.25N 可退;已注册返回 null) */
async function maybeStorageTx(chainKey: string, userAccountId: string): Promise<NearUnsignedTx | null> {
  const burrow = burrowContract(chainKey)
  const bal = await nearStorageBalance(chainKey, burrow, userAccountId)
  if (bal && BigInt(bal.total) > 0n) return null
  return {
    kind: 'near',
    receiverId: burrow,
    actions: [{ methodName: 'storage_deposit', args: {}, gas: NEAR_TX_GAS, deposit: DEFAULT_STORAGE_DEPOSIT }],
    description: `在 Burrow 注册存储押金(0.25N,可退还)`,
  }
}

/** 存款:ft_transfer_call(空 msg = 存入生息);storage 未注册时前置一笔 storage_deposit */
export async function buildBurrowSupplyTxs(chainKey: string, userAccountId: string, tokenSymbol: string, amountHuman: string): Promise<NearUnsignedTx[]> {
  const burrow = burrowContract(chainKey)
  const token = refToken(chainKey, tokenSymbol)
  const amountAtomic = await burrowToAtomic(chainKey, tokenSymbol, amountHuman)
  if (BigInt(amountAtomic) <= 0n) throw new Error('amount 必须大于 0')
  const txs: NearUnsignedTx[] = []
  const storageTx = await maybeStorageTx(chainKey, userAccountId)
  if (storageTx) txs.push(storageTx)
  txs.push({
    kind: 'near',
    receiverId: token.contractId,
    actions: [{ methodName: 'ft_transfer_call', args: { receiver_id: burrow, amount: amountAtomic, msg: '' }, gas: NEAR_TX_GAS, deposit: '1' }],
    description: `向 Burrow 存入 ${amountHuman} ${token.symbol}(生息并计入抵押)`,
  })
  return txs
}

/** 借款;amount 为代币人类单位(如 "10.5"),合约按 ft_metadata 小数位解析;storage 未注册时前置注册 */
export async function buildBurrowBorrowTxs(chainKey: string, userAccountId: string, tokenSymbol: string, amountHuman: string): Promise<NearUnsignedTx[]> {
  const burrow = burrowContract(chainKey)
  const token = refToken(chainKey, tokenSymbol)
  const txs: NearUnsignedTx[] = []
  const storageTx = await maybeStorageTx(chainKey, userAccountId)
  if (storageTx) txs.push(storageTx)
  txs.push({
    kind: 'near',
    receiverId: burrow,
    actions: [{ methodName: 'execute', args: { actions: [{ Borrow: { token_id: token.contractId, amount: amountHuman } }] }, gas: NEAR_TX_GAS, deposit: '1' }],
    description: `从 Burrow 借出 ${amountHuman} ${token.symbol}(占用抵押额度)`,
  })
  return txs
}

/** 还款:execute Repay(从 Burrow 账户的存款余额中扣,无需再转代币) */
export async function buildBurrowRepayTxs(chainKey: string, userAccountId: string, tokenSymbol: string, amountHuman: string): Promise<NearUnsignedTx[]> {
  const burrow = burrowContract(chainKey)
  const token = refToken(chainKey, tokenSymbol)
  return [
    {
      kind: 'near',
      receiverId: burrow,
      actions: [{ methodName: 'execute', args: { actions: [{ Repay: { token_id: token.contractId, amount: amountHuman } }] }, gas: NEAR_TX_GAS, deposit: '1' }],
      description: `向 Burrow 偿还 ${amountHuman} ${token.symbol} 借款`,
    },
  ]
}

/** 取回存款;amountHuman 传 null 表示全部取出(burrow 约定:不带 amount/max_amount 即全取) */
export async function buildBurrowWithdrawTxs(chainKey: string, userAccountId: string, tokenSymbol: string, amountHuman: string | null): Promise<NearUnsignedTx[]> {
  const burrow = burrowContract(chainKey)
  const token = refToken(chainKey, tokenSymbol)
  const action: Record<string, unknown> = { Withdraw: { token_id: token.contractId } }
  if (amountHuman !== null) (action.Withdraw as Record<string, unknown>).amount = amountHuman
  const desc = amountHuman !== null ? `从 Burrow 取回 ${amountHuman} ${token.symbol} 存款` : `从 Burrow 取回全部 ${token.symbol} 存款`
  return [
    {
      kind: 'near',
      receiverId: burrow,
      actions: [{ methodName: 'execute', args: { actions: [action] }, gas: NEAR_TX_GAS, deposit: '1' }],
      description: desc,
    },
  ]
}
