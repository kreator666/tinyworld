import { Buffer } from 'buffer'

// ============================================================
// Solana 钱包封装(Phantom):与 EVM 侧 EIP-6963 手写封装风格一致,
// 只做 provider 检测 / 连接 / 签名,不引入 @solana/wallet-adapter。
// 注意:Phantom 没有 chainChanged 事件,cluster(testnet/devnet/mainnet)
// 切换由用户在钱包内手动完成,前端无法探测也不需跟随。
// ============================================================

export interface SolanaWalletProvider {
  isPhantom?: boolean
  publicKey?: { toBase58(): string }
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toBase58(): string } }>
  disconnect?: () => Promise<void>
  signAndSendTransaction: (tx: unknown, opts?: unknown) => Promise<{ signature: string }>
  signTransaction?: (tx: unknown) => Promise<unknown>
  signMessage: (message: Uint8Array, display?: string) => Promise<{ signature: Uint8Array }>
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
}

export class SolanaWalletError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'SolanaWalletError'
  }
}

// 当前已连接的 Phantom provider 与地址(不可序列化,模块级暂存,供链上交易使用)
let activeSolanaProvider: SolanaWalletProvider | null = null
let activeSolanaAddress: string | null = null

/** 检测 window.solana(Phantom 优先;部分钱包如 OKX 也注入 window.solana) */
export function getSolanaProvider(): SolanaWalletProvider | null {
  if (typeof window === 'undefined') return null
  const solana = (window as unknown as { solana?: SolanaWalletProvider }).solana
  if (!solana) return null
  // isPhantom 优先;没有标记时只要有 connect/signAndSendTransaction 也视为可用
  if (solana.isPhantom) return solana
  if (typeof solana.connect === 'function' && typeof solana.signAndSendTransaction === 'function') return solana
  return null
}

export function getActiveSolanaProvider(): SolanaWalletProvider | null {
  return activeSolanaProvider
}

export function getActiveSolanaAddress(): string | null {
  return activeSolanaAddress
}

/** 已连接时校验 provider 仍可用,不可用时清空缓存 */
export function clearActiveSolana() {
  activeSolanaProvider = null
  activeSolanaAddress = null
}

export interface SolanaConnection {
  address: string
  providerName: string
}

/** 连接 Phantom 并暂存 provider/address;不签名,签名时机交给调用方(登录用 signMessage) */
export async function connectSolanaWallet(): Promise<SolanaConnection> {
  const provider = getSolanaProvider()
  if (!provider) {
    throw new SolanaWalletError('PHANTOM_NOT_FOUND', '未检测到 Phantom 钱包,请先安装扩展')
  }
  let publicKey: { toBase58(): string }
  try {
    const res = await provider.connect()
    publicKey = res.publicKey
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/reject|denied|declined|cancel/i.test(msg)) {
      throw new SolanaWalletError('USER_REJECTED', '用户拒绝了钱包连接')
    }
    throw new SolanaWalletError('CONNECT_FAILED', `连接 Phantom 失败: ${msg}`)
  }
  const address = publicKey.toBase58()
  activeSolanaProvider = provider
  activeSolanaAddress = address
  return { address, providerName: provider.isPhantom ? 'Phantom' : 'Solana Wallet' }
}

/** 交易签名发送:走 Phantom signAndSendTransaction,返回 base58 signature */
export async function solanaSignAndSend(tx: unknown): Promise<string> {
  const provider = requireSolanaProvider()
  try {
    const { signature } = await provider.signAndSendTransaction(tx)
    return signature
  } catch (err) {
    throw normalizeSignError(err)
  }
}

/** 多签名交易(如 mint_identity 需要新建 mint keypair):先本地 partialSign,再让 Phantom 签名,最后 raw send 由调用方处理 */
export async function solanaSignTransaction(tx: unknown): Promise<unknown> {
  const provider = requireSolanaProvider()
  if (!provider.signTransaction) {
    throw new SolanaWalletError('UNSUPPORTED', '当前钱包不支持 signTransaction(多签名交易)')
  }
  try {
    return await provider.signTransaction(tx)
  } catch (err) {
    throw normalizeSignError(err)
  }
}

/** 登录消息签名:返回原始签名字节(base58 编码由调用方决定) */
export async function solanaSignMessage(message: Uint8Array): Promise<Uint8Array> {
  const provider = requireSolanaProvider()
  try {
    const { signature } = await provider.signMessage(message)
    return signature
  } catch (err) {
    throw normalizeSignError(err)
  }
}

export function requireSolanaProvider(): SolanaWalletProvider {
  if (!activeSolanaProvider) {
    throw new SolanaWalletError('NOT_CONNECTED', '未检测到已连接的 Phantom 钱包,请先连接')
  }
  return activeSolanaProvider
}

function normalizeSignError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err)
  if (/reject|denied|declined|cancel/i.test(msg)) {
    return new SolanaWalletError('SIGN_REJECTED', '你取消了钱包操作')
  }
  return err instanceof Error ? err : new Error(msg)
}

/** Uint8Array → base64(登录签名编码,与 agent 服务约定) */
export function base64EncodeBytes(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

/**
 * Solana 登录消息(与 agent 服务逐字节约定,勿改动格式):
 *   AgentVerse 登录验证
 *   地址: <base58>
 *   随机数: <nonce>
 *   时间: <ISO8601>
 *   链: solana-testnet
 */
export function buildSolanaLoginMessage(address: string, nonce: string): string {
  return [
    'AgentVerse 登录验证',
    `地址: ${address}`,
    `随机数: ${nonce}`,
    `时间: ${new Date().toISOString()}`,
    '链: solana-testnet',
  ].join('\n')
}
