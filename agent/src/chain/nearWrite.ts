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
const DEFAULT_STORAGE_DEPOSIT = utils.format.parseNearAmount('0.25')! // Ref/Burrow 注册通常 ~0.1N,0.25N 留余量(可退还)

/** Agent NEAR 热钱包是否就绪(有私钥即视为就绪,账户不存在时首笔交易会报可读错误) */
export function isNearWriteReady(): boolean {
  return Boolean(config.agentNearKey)
}

/** 热钱包账户 id:显式配置优先,缺省公钥隐式地址 */
export function nearAgentAccountId(): string {
  if (config.agentNearAccountId) return config.agentNearAccountId
  if (!config.agentNearKey) throw new Error('未配置 AGENT_NEAR_PRIVATE_KEY')
  const hex = Buffer.from(KeyPair.fromString(config.agentNearKey as `ed25519:${string}`).getPublicKey().data).toString('hex')
  return hex
}

function keyPair(): KeyPair {
  if (!config.agentNearKey) throw new Error('未配置 AGENT_NEAR_PRIVATE_KEY')
  return KeyPair.fromString(config.agentNearKey as `ed25519:${string}`)
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

/** 用给定端点构建 Account */
async function accountAt(chainKey: string, nodeUrl: string): Promise<import('near-api-js').Account> {
  const cfg = getChainContext(chainKey).cfg
  const keyStore = new keyStores.InMemoryKeyStore()
  const id = nearAgentAccountId()
  await keyStore.setKey(cfg.chainId === 398 ? 'testnet' : 'mainnet', id, keyPair())
  const near = await connect({ networkId: cfg.chainId === 398 ? 'testnet' : 'mainnet', nodeUrl, keyStore, headers: {} })
  return near.account(id)
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
      const account = await accountAt(chainKey, url)
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
  const me = nearAgentAccountId()
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
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: nearAgentAccountId() } }),
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
