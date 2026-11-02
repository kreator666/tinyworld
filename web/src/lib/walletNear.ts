import { Buffer } from 'buffer'
import {
  setupWalletSelector,
  internalActionToNaj,
  type WalletSelector,
  type Network,
  type FunctionCallAction,
  type InternalAction,
} from '@near-wallet-selector/core'
import { setupModal, type WalletSelectorModal } from '@near-wallet-selector/modal-ui'
import '@near-wallet-selector/modal-ui/styles.css'
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet'
import { getActiveChain } from '../store/chainConfigStore'

// ============================================================
// NEAR 钱包封装(wallet-selector:MyNearWallet / Meteor)
// 与 EVM 侧 EIP-6963 封装、Solana 侧 Phantom 封装风格一致:
// 只做 selector 初始化 / 连接 / 签名,链上读写见 lib/chainNear.ts。
// NEAR 的"地址"就是 account_id(如 alice.testnet)。
// 会话由 wallet-selector 持久化在 localStorage(key 含合约地址),
// 刷新后通过 initNearSession 恢复并校验与登录身份一致。
// 注:meteor-wallet 的浏览器 bundle 混有 Node 风格依赖(randombytes 引用 global/process,
//    靠 vite define 垫片规避);为防其再出运行时错误拖垮整个应用,改为异步按需加载,
//    加载失败仅跳过该钱包,不影响 MyNearWallet 与整体功能。
// ============================================================

/** 加载钱包模块:MyNearWallet 必载;Meteor 按需异步载,失败跳过(其浏览器 bundle 有 Node 依赖坑) */
async function loadNearWalletModules(): Promise<Array<ReturnType<typeof setupMyNearWallet>>> {
  const modules: Array<ReturnType<typeof setupMyNearWallet>> = [setupMyNearWallet()]
  try {
    const { setupMeteorWallet } = await import('@near-wallet-selector/meteor-wallet')
    modules.push(setupMeteorWallet() as unknown as ReturnType<typeof setupMyNearWallet>)
  } catch (err) {
    console.warn('[near] meteor-wallet 模块加载失败,已跳过该钱包(不影响其他功能):', err)
  }
  return modules
}

export class NearWalletError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'NearWalletError'
  }
}

export interface NearConnection {
  address: string // NEAR account_id
  providerName: string
}

// 当前已连接账户(account_id,不可序列化,模块级暂存,供链上交易/登录校验使用)
let activeNearAccount: string | null = null
let selectorPromise: Promise<WalletSelector> | null = null
let modal: WalletSelectorModal | null = null

/** localStorage 里的账户镜像(快速比对用;权威数据在 wallet-selector 自己的存储里) */
const ACCOUNT_MIRROR_KEY = 'tinyworld-near-account'

/** NEAR account_id 合法性:小写字母/数字/._-,2-64 位,分隔符不可相邻/首尾;或 64 位 hex 隐式账户 */
export function isValidNearAddress(input: string | null | undefined): boolean {
  if (!input || input.length < 2 || input.length > 64) return false
  if (/^[0-9a-f]{64}$/.test(input)) return true // 隐式账户
  if (!/^[a-z0-9._-]+$/.test(input)) return false
  if (/^[._-]|[._-]$/.test(input)) return false
  return !/[._-]{2}/.test(input)
}

export function getActiveNearAccount(): string | null {
  return activeNearAccount
}

/** 断开/切链时清空模块级缓存(钱包 selector 的持久存储由 disconnectNearWallet 清除) */
export function clearActiveNear() {
  activeNearAccount = null
  try {
    localStorage.removeItem(ACCOUNT_MIRROR_KEY)
  } catch {
    // localStorage 不可用时忽略
  }
}

/** 构建 selector(幂等);network 跟随激活链配置(合约地址 = identity 字段) */
async function ensureSelector(): Promise<WalletSelector> {
  if (selectorPromise) return selectorPromise
  const chain = getActiveChain()
  selectorPromise = setupWalletSelector({
    network: {
      networkId: 'testnet',
      nodeUrl: chain.rpc,
    } as Network,
    // v10 参数名:签约时给钱包创建 FunctionCall 访问密钥(空 methodNames = 不限制方法)
    createAccessKeyFor: { contractId: chain.identity, methodNames: [] },
    modules: await loadNearWalletModules(),
  }).catch((err) => {
    selectorPromise = null
    throw err
  })
  const selector = await selectorPromise
  modal ??= setupModal(selector, { contractId: chain.identity })
  // 全局订阅:钱包内切换/断开账户时同步缓存(登录态一致性由 App.tsx 强制校验)
  selector.store.observable.subscribe((state) => {
    const accountId = state.accounts[0]?.accountId ?? null
    activeNearAccount = accountId
    try {
      if (accountId) localStorage.setItem(ACCOUNT_MIRROR_KEY, accountId)
      else localStorage.removeItem(ACCOUNT_MIRROR_KEY)
    } catch {
      // 忽略持久化失败
    }
  })
  return selector
}

/** 刷新页面后恢复 NEAR 会话:返回当前已签入的 account_id(未登录返回 null) */
export async function initNearSession(): Promise<string | null> {
  const selector = await ensureSelector()
  const accountId = selector.store.getState().accounts[0]?.accountId ?? null
  activeNearAccount = accountId
  if (accountId) {
    try {
      localStorage.setItem(ACCOUNT_MIRROR_KEY, accountId)
    } catch {
      // 忽略持久化失败
    }
  }
  return accountId
}

/** 订阅账户变化(钱包内切换/登出);返回取消订阅函数 */
export function onNearAccountsChanged(cb: (accountId: string | null) => void): () => void {
  let disposed = false
  ensureSelector()
    .then((selector) => {
      if (disposed) return
      const sub = selector.store.observable.subscribe((state) => {
        cb(state.accounts[0]?.accountId ?? null)
      })
      cleanups.set(cb, () => sub.unsubscribe())
    })
    .catch(() => {})
  return () => {
    disposed = true
    cleanups.get(cb)?.()
    cleanups.delete(cb)
  }
}
const cleanups = new Map<(accountId: string | null) => void, () => void>()

/** 弹 wallet-selector 连接窗口;已签入则直接复用。不签名,签名时机交给调用方(SIWE 登录) */
export async function connectNearWallet(): Promise<NearConnection> {
  const selector = await ensureSelector()
  // 刷新后已恢复会话(钱包 selector 自身持久化):直接复用,不重复弹窗
  const restored = selector.store.getState().accounts[0]?.accountId
  if (restored) {
    activeNearAccount = restored
    return { address: restored, providerName: selector.store.getState().selectedWalletId ?? 'NEAR' }
  }
  return new Promise<NearConnection>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sub.unsubscribe()
      fn()
    }
    // 2 分钟未签入视为放弃(用户在钱包侧关闭窗口不会触发事件)
    const timer = setTimeout(() => {
      finish(() => reject(new NearWalletError('CONNECT_TIMEOUT', '连接 NEAR 钱包超时,请重试')))
    }, 120_000)
    const sub = selector.store.observable.subscribe((state) => {
      const accountId = state.accounts[0]?.accountId
      if (!accountId) return
      finish(() => {
        activeNearAccount = accountId
        resolve({ address: accountId, providerName: state.selectedWalletId ?? 'NEAR' })
      })
    })
    modal?.show()
  })
}

/** 登出并清空本地会话 */
export async function disconnectNearWallet(): Promise<void> {
  try {
    const selector = await ensureSelector()
    const wallet = await selector.wallet()
    await wallet.signOut()
  } catch {
    // 钱包未初始化时静默
  }
  clearActiveNear()
}

/**
 * 登录挑战:用钱包签名一笔指向身份合约的 login_challenge(nonce) 交易并广播,
 * 返回交易哈希(作为 /auth/verify 的 signature 字段,后端按哈希向 RPC 核对签名者/nonce/执行状态)。
 * 说明:NEP-413 signMessage 的钱包侧实现(MyNearWallet 等)只回签名不回复签名负载
 * (timestamp 由钱包生成),服务端无法重建 borsh 验签,故 NEAR 登录改用链上挑战。
 */
export async function nearLoginChallenge(nonce: string): Promise<string> {
  return nearSignAndSend([nearFunctionCall('login_challenge', { nonce })])
}

/** 签名并发送交易(FunctionCall 单合约动作);返回 NEAR tx hash */
export async function nearSignAndSend(actions: InternalAction[], receiverId?: string): Promise<string> {
  const selector = await ensureSelector()
  const wallet = await selector.wallet()
  try {
    // v10 的 signAndSendTransactions 收 @near-js 枚举式 Action(浏览器钱包可能走重定向返回 void)
    const outcomes = (await wallet.signAndSendTransactions({
      transactions: [
        {
          receiverId: receiverId ?? getActiveChain().identity,
          actions: actions.map(internalActionToNaj),
        },
      ],
    })) as Array<{ transaction_outcome?: { id?: string }; transaction?: { hash?: string } }> | void
    const outcome = Array.isArray(outcomes) ? outcomes[0] : undefined
    const hash = outcome?.transaction_outcome?.id ?? outcome?.transaction?.hash ?? ''
    if (!hash) throw new Error('NEAR 交易未返回哈希')
    return hash
  } catch (err) {
    throw normalizeNearError(err)
  }
}

/** FunctionCall 动作构造辅助(gas/deposit 均为字符串:gas/yoctoNEAR 单位原样上链) */
export function nearFunctionCall(methodName: string, args: Record<string, unknown>, gas = '50000000000000', deposit = '0'): FunctionCallAction {
  return {
    type: 'FunctionCall',
    params: { methodName, args, gas, deposit },
  }
}

function normalizeNearError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err)
  if (/reject|denied|declined|cancel|closed|dismiss/i.test(msg)) {
    return new NearWalletError('SIGN_REJECTED', '你取消了钱包操作')
  }
  return err instanceof Error ? err : new Error(msg)
}

/**
 * NEAR 登录消息(与 agent 服务逐字节约定,勿改动格式):
 *   AgentVerse 登录验证
 *   地址: <account_id>
 *   随机数: <nonce>
 *   时间: <ISO8601>
 *   链: <chainKey>
 */
export function buildNearLoginMessage(address: string, nonce: string, chainKey = 'near-testnet'): string {
  return [
    'AgentVerse 登录验证',
    `地址: ${address}`,
    `随机数: ${nonce}`,
    `时间: ${new Date().toISOString()}`,
    `链: ${chainKey}`,
  ].join('\n')
}
