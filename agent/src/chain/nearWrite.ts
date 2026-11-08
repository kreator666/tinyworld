import { connect, keyStores, KeyPair, utils } from 'near-api-js'
import { config } from '../config'
import { getChainContext } from './registry'

// ============================================================
// NEAR 写路径(hot_wallet 模式):Agent 热钱包签名并广播 FunctionCall 交易。
// - 私钥经 AGENT_NEAR_PRIVATE_KEY(ed25519:...)注入;账户 = AGENT_NEAR_ACCOUNT_ID,
//   缺省取公钥推导的隐式账户(hex(public key))
// - RPC 主备轮换:仅对连接级错误(fetch 失败/超时)重试下一个端点;
//   执行类错误(余额不足/合约 panic)不重试——交易可能已广播,重试会重复发送
// - NEAR DeFi 协议(Ref/Burrow)要求 NEP-145 storage deposit,ensureStorageDeposit 幂等注册
// 协议模块(chain/ref.ts、chain/burrow.ts、defi-swap-ref / defi-lending-burrow 技能)共用本模块。
// ============================================================

const GAS = 100n * 10n ** 12n // 100 Tgas
/** 存储押金标准额:Ref/Burrow 注册通常 ~0.1N,0.25N 留余量(可退还) */
export const DEFAULT_STORAGE_DEPOSIT = utils.format.parseNearAmount('0.25')!

/** 未签名交易动作:缺省 type 即 functionCall(向后兼容);transfer = 原生 NEAR 转账(yoctoNEAR 字符串) */
export type NearTxAction =
  | { type?: 'functionCall'; methodName: string; args: Record<string, unknown>; gas?: string; deposit?: string }
  | { type: 'transfer'; amount: string }

/** NEAR 未签名交易(user_wallet 模式;kind='near',前端逐笔交钱包 signAndSendTransactions) */
export interface NearUnsignedTx {
  kind: 'near'
  /** 交易接收合约(exchange/wrap/代币/burrow/收款账户 等) */
  receiverId: string
  actions: NearTxAction[]
  description: string
}

/** 组装交易通用的 FunctionCall gas(与 hot 路径 nearCall 的 100 Tgas 一致) */
export const NEAR_TX_GAS = '100000000000000' // 100 Tgas

/** NEP-141 ft_transfer 事件(EVENT_JSON 标准),sign-confirm 解析实际到账用 */
export interface NearFtTransferEvent {
  standard?: string
  event?: string
  data?: Array<{ old_owner_id?: string; new_owner_id?: string; amount?: string }>
}

/** Agent NEAR 热钱包是否就绪(有私钥即视为就绪,账户不存在时首笔交易会报可读错误) */
export function isNearWriteReady(): boolean {
  return Boolean(config.agentNearKey)
}

/** 热钱包账户 id:显式配置优先,缺省公钥隐式地址。
 *  传 chainKey 时:near-mainnet 且配了主网专用账户 → 返回主网账户(生存模式收款/分配用) */
export function nearAgentAccountId(chainKey?: string): string {
  if (chainKey && getChainContext(chainKey).cfg.chainId !== 398 && config.agentNearMainnetAccountId) {
    return config.agentNearMainnetAccountId
  }
  if (config.agentNearAccountId) return config.agentNearAccountId
  if (!config.agentNearKey) throw new Error('未配置 AGENT_NEAR_PRIVATE_KEY')
  const hex = Buffer.from(KeyPair.fromString(config.agentNearKey as `ed25519:${string}`).getPublicKey().data).toString('hex')
  return hex
}

function keyPair(): KeyPair {
  if (!config.agentNearKey) throw new Error('未配置 AGENT_NEAR_PRIVATE_KEY')
  return KeyPair.fromString(config.agentNearKey as `ed25519:${string}`)
}

/** 主网专用热钱包(生存模式):AGENT_NEAR_MAINNET_KEYS 是 {"<receiverId>": "ed25519:...", "default": ...} JSON。
 *  每个 receiver 一把受限 FunctionCall 子密钥(NEAR 协议一把函数调用钥匙只限一个合约),
 *  按交易目标合约选钥匙;泄露也转不走钱(不支持 Transfer),可在线 delete-key 吊销。 */
function mainnetKeyFor(receiverId?: string): string | null {
  const raw = config.agentNearMainnetKeys
  if (!raw) return null
  try {
    const map = JSON.parse(raw) as Record<string, string>
    return (receiverId && map[receiverId]) || map.default || null
  } catch {
    return null
  }
}

/** 用给定端点构建 Account;receiverId 用于主网按合约选受限子密钥 */
async function accountAt(chainKey: string, nodeUrl: string, receiverId?: string): Promise<import('near-api-js').Account> {
  const cfg = getChainContext(chainKey).cfg
  const keyStore = new keyStores.InMemoryKeyStore()
  const networkId = cfg.chainId === 398 ? 'testnet' : 'mainnet'
  const mainnetSecret = networkId === 'mainnet' ? mainnetKeyFor(receiverId) : null
  const id = nearAgentAccountId(chainKey)
  const kp = mainnetSecret ? KeyPair.fromString(mainnetSecret as `ed25519:${string}`) : keyPair()
  await keyStore.setKey(networkId, id, kp)
  const near = await connect({ networkId, nodeUrl, keyStore, headers: {} })
  return near.account(id)
}

function endpoints(chainKey: string): string[] {
  const cfg = getChainContext(chainKey).cfg
  return [cfg.rpc, ...(cfg.rpcFallbacks ?? [])]
}

/** 连接级错误才可安全重试(交易尚未发出);执行错误可能已上链,重试会双花 */
function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? `${(err as { type?: string }).type ?? ''} ${err.message}` : String(err)
  return /failed to fetch|fetch failed|timeout|econn|socket|network/i.test(msg) && !/account|balance|gas|wasm|panic|execution|insufficient|denied|key/i.test(msg)
}

/**
 * 热钱包发起一笔 FunctionCall,返回交易哈希。
 * 主端点连接失败时按 rpcFallbacks 轮换重试;执行错误原样抛出。
 */
export async function nearCall(chainKey: string, contractId: string, methodName: string, args: Record<string, unknown>, depositYocto: string | bigint = '0'): Promise<string> {
  const eps = endpoints(chainKey)
  let lastErr: unknown = null
  for (const url of eps) {
    try {
      const account = await accountAt(chainKey, url, contractId)
      const outcome = await account.functionCall({
        contractId,
        methodName,
        args,
        gas: GAS,
        attachedDeposit: BigInt(depositYocto),
      })
      const hash = (outcome as { transaction_outcome?: { id?: string }; transaction?: { hash?: string } })?.transaction_outcome?.id
        ?? (outcome as { transaction?: { hash?: string } })?.transaction?.hash
      if (!hash) throw new Error('交易未返回哈希')
      return hash
    } catch (err) {
      lastErr = err
      if (!isRetryable(err)) throw err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** view 调用(只读;主备轮换;空结果按瞬时异常重试最多 3 次) */
export async function nearView<T>(chainKey: string, contractId: string, methodName: string, args: Record<string, unknown>): Promise<T | null> {
  const eps = endpoints(chainKey)
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of eps) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'query',
            params: { request_type: 'call_function', finality: 'final', account_id: contractId, method_name: methodName, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') },
          }),
          signal: AbortSignal.timeout(15_000),
        })
        const data = (await res.json()) as { error?: { message?: string }; result?: { result?: number[]; error?: string } }
        if (data.error) throw new Error(data.error.message ?? 'RPC 错误')
        if (data.result?.error) throw new Error(data.result.error)
        if (!data.result?.result) throw new Error('RPC 返回空结果(可能处于最终性间隙)')
        return JSON.parse(Buffer.from(data.result.result).toString('utf8')) as T
      } catch (err) {
        lastErr = err
      }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 账户在指定合约的 NEP-145 存储余额(未注册返回 null) */
export async function nearStorageBalance(chainKey: string, contractId: string, accountId: string): Promise<{ total: string; available: string } | null> {
  return nearView<{ total: string; available: string }>(chainKey, contractId, 'storage_balance_of', { account_id: accountId })
}

/**
 * 幂等 storage deposit 注册(Ref/Burrow 交易前置条件)。
 * 已注册返回 false;未注册发一笔 storage_deposit(可退还)返回 true。
 */
export async function ensureStorageDeposit(chainKey: string, contractId: string): Promise<boolean> {
  const me = nearAgentAccountId(chainKey)
  const bal = await nearStorageBalance(chainKey, contractId, me)
  if (bal && BigInt(bal.total) > 0n) return false
  await nearCall(chainKey, contractId, 'storage_deposit', {}, DEFAULT_STORAGE_DEPOSIT)
  return true
}

/** 热钱包原生 NEAR 余额(view_account,单位 yoctoNEAR 字符串) */
export async function nearNativeBalance(chainKey: string): Promise<string> {
  const eps = endpoints(chainKey)
  let lastErr: unknown = null
  for (const url of eps) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: nearAgentAccountId(chainKey) } }),
        signal: AbortSignal.timeout(15_000),
      })
      const data = (await res.json()) as { error?: { message?: string }; result?: { amount?: string } }
      if (data.error) throw new Error(data.error.message ?? 'RPC 错误')
      return data.result?.amount ?? '0'
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 'tx' RPC 的原始执行结果(轮询与事件解析共用) */
export interface NearTxExecution {
  status?: Record<string, unknown>
  receipts_outcome?: Array<{ outcome?: { logs?: string[] } }>
}

/** 'tx' RPC 结果里的交易头(sign-confirm 核验签名人与动作用;actions 为 NEAR 原生形状 {Transfer:{deposit}}/{FunctionCall:{...}}) */
export interface NearTxDetail extends NearTxExecution {
  transaction?: {
    signer_id?: string
    receiver_id?: string
    actions?: Array<Record<string, unknown>>
  }
}

/** 单笔 'tx' 查询(主备轮换);"交易不存在"视为尚未达最终性,返回 null 由调用方继续轮询 */
async function nearTxQuery(chainKey: string, txHash: string, senderAccountId: string): Promise<NearTxExecution | null> {
  const eps = endpoints(chainKey)
  let lastErr: unknown = null
  for (const url of eps) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tx', params: { tx_hash: txHash, sender_account_id: senderAccountId } }),
        signal: AbortSignal.timeout(15_000),
      })
      const data = (await res.json()) as { error?: { message?: string }; result?: NearTxExecution }
      if (data.error) {
        // 尚未上链/未达最终性:节点回 UNKNOWN_TRANSACTION,继续轮询而非报错
        if (/unknown|doesn't exist|not found|does not exist/i.test(data.error.message ?? '')) return null
        throw new Error(data.error.message ?? 'RPC 错误')
      }
      return data.result ?? null
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * 轮询交易最终性('tx' RPC;主备轮换),SUCCESS/FAILURE 即返回执行结果;超时(~30s)抛错由调用方按待确认处理。
 * senderAccountId:user_wallet 模式下全部交易都由主人钱包签名,即 proposal.params.owner。
 */
export async function nearWaitTxFinal(chainKey: string, txHash: string, senderAccountId: string, timeoutMs = 30_000): Promise<NearTxExecution> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const exec = await nearTxQuery(chainKey, txHash, senderAccountId)
    if (exec?.status) {
      if ('SuccessValue' in exec.status || 'SuccessReceiptId' in exec.status) return exec
      if ('Failure' in exec.status) return exec
    }
    if (Date.now() >= deadline) throw new Error(`确认超时(${Math.round(timeoutMs / 1000)}s)`)
    await new Promise((r) => setTimeout(r, 2000))
  }
}

/** 从执行结果日志解析代币转账事件中账户的入账/出账合计;无事件返回 null。
 *  兼容两种日志:NEP-141 EVENT_JSON 标准事件,以及 testnet fakes/ref 老合约的 "Transfer {amount} from {A} to {B}" 纯文本 */
export function nearFtTransfersOf(exec: NearTxExecution, accountId: string): { in: bigint; out: bigint } | null {
  let totalIn: bigint | null = null
  let totalOut: bigint | null = null
  const add = (oldOwner: string | undefined, newOwner: string | undefined, amountRaw: string | undefined) => {
    const amount = amountRaw ? BigInt(amountRaw) : null
    if (!amount) return
    if (newOwner === accountId) totalIn = (totalIn ?? 0n) + amount
    if (oldOwner === accountId) totalOut = (totalOut ?? 0n) + amount
  }
  for (const r of exec.receipts_outcome ?? []) {
    for (const log of r.outcome?.logs ?? []) {
      const legacy = log.match(/^Transfer (\d+) from (\S+) to (\S+)$/)
      if (legacy) {
        add(legacy[2], legacy[3], legacy[1])
        continue
      }
      const m = log.match(/EVENT_JSON:(\{.*\})/)
      if (!m) continue
      let evt: NearFtTransferEvent
      try {
        evt = JSON.parse(m[1]) as NearFtTransferEvent
      } catch {
        continue
      }
      if (evt.standard !== 'nep141' || evt.event !== 'ft_transfer') continue
      for (const d of evt.data ?? []) add(d.old_owner_id, d.new_owner_id, d.amount)
    }
  }
  if (totalIn === null && totalOut === null) return null
  return { in: totalIn ?? 0n, out: totalOut ?? 0n }
}
