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
import { getActiveChain } from '../store/chainConfigStore'
import { agentApiBase } from './agentApi'

// ============================================================
// NEAR 钱包封装(wallet-selector:Meteor / Sender / Nightly / HERE)
// 与 EVM 侧 EIP-6963 封装、Solana 侧 Phantom 封装风格一致:
// 只做 selector 初始化 / 连接 / 签名,链上读写见 lib/chainNear.ts。
// NEAR 的"地址"就是 account_id(如 alice.testnet)。
// 会话由 wallet-selector 持久化在 localStorage(key 含合约地址),
// 刷新后通过 initNearSession 恢复并校验与登录身份一致。
// 注1:MyNearWallet 已于 2026 年退役,官方不再接受新应用连接,故不接。
// 注2:多钱包冗余是刻意为之——NEAR 测试网单点故障频发(2026-11 Meteor 后端
//     间歇性 -32601,官方 RPC 弃用),钱包模块全部异步按需加载、失败互不影响,
//     用户可在弹窗里任选可用钱包。
// ============================================================

/** 加载钱包模块:全部异步按需载,单个失败仅跳过该钱包(其浏览器 bundle 可能有 Node 依赖坑)。
 *  注意:动态导入必须写字面量包名——变量形式的 import() 无法被 Vite 分析/预构建(实测踩坑)。 */
async function loadNearWalletModules() {
  const modules: unknown[] = []
  const add = (m: unknown) => {
    if (typeof m === 'function') modules.push((m as () => unknown)())
  }
  try {
    add((await import('@near-wallet-selector/meteor-wallet')).setupMeteorWallet)
  } catch (err) {
    console.warn('[near] meteor-wallet 模块加载失败,已跳过:', err)
  }
  try {
    add((await import('@near-wallet-selector/sender')).setupSender)
  } catch (err) {
    console.warn('[near] sender 模块加载失败,已跳过:', err)
  }
  try {
    add((await import('@near-wallet-selector/nightly')).setupNightly)
  } catch (err) {
    console.warn('[near] nightly 模块加载失败,已跳过:', err)
  }
  try {
    add((await import('@near-wallet-selector/here-wallet')).setupHereWallet)
  } catch (err) {
    console.warn('[near] here-wallet 模块加载失败,已跳过:', err)
  }
  return modules as never[]
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
  selectorPromise = null
  modal = null
  selectorChainKey = null
  try {
    localStorage.removeItem(ACCOUNT_MIRROR_KEY)
  } catch {
    // localStorage 不可用时忽略
  }
}

/**
 * NEAR JSON-RPC 中继地址(agent /near-rpc/:network):浏览器直连公共 RPC 在用户网络
 * 环境下不稳定(经服务器转发,阿里云→fastnear 实测稳定)。钱包 selector 与链上读取统一走这里。
 */
export function nearRelayUrl(): string {
  const base = agentApiBase() || window.location.origin
  const net = getActiveChain().chainId === 398 ? 'testnet' : 'mainnet'
  return `${base}/near-rpc/${net}`
}

/** 构建 selector(幂等);network 跟随激活链配置(合约地址 = identity 字段)。
 *  切换 NEAR 链(testnet↔mainnet)时重建:中继地址与访问密钥合约都随链变化。 */
let selectorChainKey: string | null = null
async function ensureSelector(): Promise<WalletSelector> {
  const chain = getActiveChain()
  if (selectorPromise && selectorChainKey === chain.key) return selectorPromise
  selectorChainKey = chain.key
  selectorPromise = setupWalletSelector({
    network: {
      networkId: chain.chainId === 398 ? 'testnet' : 'mainnet',
      nodeUrl: nearRelayUrl(),
    } as Network,
    // v10 参数名:签约时给钱包创建 FunctionCall 访问密钥(空 methodNames = 不限制方法)
    createAccessKeyFor: { contractId: chain.identity, methodNames: [] },
    modules: await loadNearWalletModules(),
  }).catch((err) => {
    selectorPromise = null
    selectorChainKey = null
    throw err
  })
  const selector = await selectorPromise
  modal = setupModal(selector, { contractId: chain.identity })
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

// ------------------------------------------------------------
// 按钱包分键直连(插件 / 网页分离按钮):不经 selector 弹窗列表,每个钱包一个独立按钮。
// 安装检测依据各钱包的浏览器注入全局对象;forceWeb 仅对 Meteor 有意义(屏蔽扩展标记强制网页授权)。
// ------------------------------------------------------------

export interface NearWalletOption {
  id: string // selector 模块 id
  name: string
  installed: boolean
  webFallback?: boolean // 无扩展时的网页通道(仅 Meteor)
}

/** 探测各 NEAR 钱包扩展注入;返回全部候选(未安装的也列出,UI 决定隐藏或标注) */
export function detectNearWallets(): NearWalletOption[] {
  if (typeof window === 'undefined') return []
  const w = window as unknown as Record<string, unknown>
  const near = w['near'] as { isSender?: boolean } | undefined
  return [
    { id: 'meteor-wallet', name: 'Meteor', installed: w['meteorCom'] != null, webFallback: true },
    { id: 'nightly', name: 'Nightly', installed: w['nightly'] != null },
    { id: 'sender', name: 'Sender', installed: near?.isSender === true },
    { id: 'here-wallet', name: 'HERE', installed: w['hereWallet'] != null },
  ]
}

let savedMeteorCom: unknown = undefined
let meteorComSuppressed = false

/** 临时屏蔽/恢复 Meteor 扩展标记(window.meteorCom);forceWeb 登录全程保持屏蔽 */
export function suppressMeteorExtension(on: boolean): void {
  if (typeof window === 'undefined') return
  const w = window as { meteorCom?: unknown }
  if (on) {
    if (!meteorComSuppressed) {
      savedMeteorCom = w.meteorCom
      w.meteorCom = null
      meteorComSuppressed = true
    }
  } else if (meteorComSuppressed) {
    w.meteorCom = savedMeteorCom
    meteorComSuppressed = false
  }
}

/** 按钱包 id 直连登录(不弹 selector 列表);forceWeb 仅 Meteor 使用 */
export async function connectNearWalletById(walletId: string, forceWeb = false): Promise<NearConnection> {
  const selector = await ensureSelector()
  const state = selector.store.getState()
  const restored = state.accounts[0]?.accountId
  // 复用会话的前提是钱包也匹配;否则(残留的其他钱包会话,如早前 Meteor 测试网登录)先签出再连,
  // 否则后续 signAndSendTransactions 会走到旧钱包的签名路径报 "Failed to find matching key"
  if (restored && state.selectedWalletId === walletId) {
    activeNearAccount = restored
    return { address: restored, providerName: walletId }
  }
  if (restored) {
    try {
      const old = await selector.wallet()
      await old.signOut()
    } catch {
      // 旧会话签出失败不阻塞,继续以请求的钱包签入
    }
  }
  if (forceWeb) suppressMeteorExtension(true)
  try {
    const wallet = await selector.wallet(walletId)
    // selector.wallet() 返回全类型联合,signIn 形参是各钱包类型交集;NEAR 均为浏览器钱包,按最宽形态调用
    const signIn = wallet.signIn as unknown as (params: { contractId?: string; methodNames?: string[] }) => Promise<unknown[]>
    await signIn({ contractId: getActiveChain().identity, methodNames: [] })
    const accountId = selector.store.getState().accounts[0]?.accountId
    if (!accountId) throw new NearWalletError('SIGN_IN_FAILED', '钱包未返回账户,请重试')
    activeNearAccount = accountId
    return { address: accountId, providerName: walletId }
  } finally {
    if (forceWeb) suppressMeteorExtension(false)
  }
}

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
 * 注意:网页版钱包(Meteor Web)走整页重定向,不会返回哈希——调用方需先用 stashNearLogin
 * 暂存登录上下文,重定向回来后在 App 启动时经 takeNearLoginReturn 接住回调完成验签。
 */
export async function nearLoginChallenge(nonce: string): Promise<string> {
  return nearSignAndSend([nearFunctionCall('login_challenge', { nonce })])
}

// ------------------------------------------------------------
// 网页钱包重定向登录的回调承接(Meteor Web / 未装扩展时的 fallback)
// 网页钱包签完交易整页跳回,URL 带 ?transactionHashes=<hash>(失败带 ?errorCode=...),
// 跳转前暂存的登录上下文存 sessionStorage,回来后完成 /auth/verify。
// ------------------------------------------------------------

export interface NearLoginPending {
  message: string
  address: string
  nonce: string
  providerName: string
  chainId: number
  timestamp: number
}

const LOGIN_STASH_KEY = 'tinyworld-near-login-pending'

/** 发起挑战交易前暂存登录上下文(供重定向回来后完成验签) */
export function stashNearLogin(pending: Omit<NearLoginPending, 'timestamp'>): void {
  try {
    sessionStorage.setItem(LOGIN_STASH_KEY, JSON.stringify({ ...pending, timestamp: Date.now() }))
  } catch {
    // sessionStorage 不可用时网页钱包登录无法自动接续(扩展路径不受影响)
  }
}

function clearStash(): void {
  try {
    sessionStorage.removeItem(LOGIN_STASH_KEY)
  } catch {}
}

/** 清掉 URL 上的 transactionHashes/errorCode 等钱包回调参数(不刷新页面) */
function cleanWalletCallbackParams(): void {
  try {
    const url = new URL(window.location.href)
    for (const k of ['transactionHashes', 'transactionHash', 'errorCode', 'errorMessage', 'accountId']) url.searchParams.delete(k)
    window.history.replaceState(null, '', url.toString())
  } catch {}
}

/**
 * 应用启动时调用:若当前 URL 是网页钱包签完交易后的重定向回调,返回待完成的登录信息。
 * 消费一次性(取出即清 stash 并清理 URL 参数)。非回调场景返回 null。
 */
export function takeNearLoginReturn():
  | { kind: 'success'; txHash: string; pending: NearLoginPending }
  | { kind: 'error'; error: string }
  | null {
  let params: URLSearchParams
  try {
    params = new URL(window.location.href).searchParams
  } catch {
    return null
  }
  const txHashes = params.get('transactionHashes') ?? params.get('transactionHash')
  const errorCode = params.get('errorCode') ?? params.get('errorMessage')
  if (!txHashes && !errorCode) return null

  let pending: NearLoginPending | null = null
  try {
    const raw = sessionStorage.getItem(LOGIN_STASH_KEY)
    if (raw) pending = JSON.parse(raw) as NearLoginPending
  } catch {}
  clearStash()
  cleanWalletCallbackParams()

  if (errorCode) return { kind: 'error', error: `钱包拒绝了签名(${errorCode})` }
  const txHash = txHashes!.split(',')[0].trim()
  if (!txHash) return { kind: 'error', error: '钱包回调缺少交易哈希' }
  if (!pending) return { kind: 'error', error: '登录会话已过期,请重试(重定向前未暂存上下文或会话已失效)' }
  // 会话有效期 10 分钟
  if (Date.now() - pending.timestamp > 10 * 60 * 1000) return { kind: 'error', error: '登录会话已过期,请重试' }
  return { kind: 'success', txHash, pending }
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
