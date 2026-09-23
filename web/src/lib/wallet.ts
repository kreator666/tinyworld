import { createWalletClient, custom, type WalletClient, type Address } from 'viem'

// 目标钱包列表
export interface TargetWallet {
  name: string
  icon: string
  rdns: string // EIP-6963 rdns
}

export const targetWallets: TargetWallet[] = [
  { name: 'MetaMask', icon: '🦊', rdns: 'io.metamask' },
  { name: 'Coinbase', icon: '🔵', rdns: 'com.coinbase.wallet' },
  { name: 'OKX', icon: '⭕', rdns: 'com.okex.wallet' },
  { name: 'TrustWallet', icon: '🛡️', rdns: 'com.trustwallet.app' },
]

export interface DiscoveredWallet extends TargetWallet {
  installed: boolean
  detail?: EIP6963ProviderDetail
}

export interface EIP6963ProviderInfo {
  uuid: string
  name: string
  icon: string
  rdns: string
}

export interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo
  provider: EIP1193Provider
}

export interface EIP1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
  providers?: EIP1193Provider[]
  isMetaMask?: boolean
  isCoinbaseWallet?: boolean
  isOkxWallet?: boolean
  isTrust?: boolean
  isTrustWallet?: boolean
}

export interface WalletLoginResult {
  address: Address
  signature: `0x${string}`
  chainId: number
  nonce: string
  timestamp: number
  provider: string
}

export class WalletError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'WalletError'
  }
}

const EIP712_DOMAIN_NAME = 'AgentVerse'
const EIP712_DOMAIN_VERSION = '1'
const EIP712_TYPE = 'Login' as const

let discoveredProviders: EIP6963ProviderDetail[] = []

// 当前已连接钱包的 provider(不可序列化,模块级暂存,供链上交易使用)
let activeProvider: EIP1193Provider | null = null

export function setActiveProvider(provider: EIP1193Provider | null) {
  activeProvider = provider
}

export function getActiveProvider(): EIP1193Provider | null {
  return activeProvider
}

function matchRdnsToTarget(rdns: string): TargetWallet | undefined {
  return targetWallets.find((t) => t.rdns.toLowerCase() === rdns.toLowerCase())
}

function matchProviderToTarget(provider: EIP1193Provider): TargetWallet | undefined {
  if (provider.isMetaMask) return targetWallets.find((t) => t.name === 'MetaMask')
  if (provider.isCoinbaseWallet) return targetWallets.find((t) => t.name === 'Coinbase')
  if (provider.isOkxWallet) return targetWallets.find((t) => t.name === 'OKX')
  if (provider.isTrust || provider.isTrustWallet) return targetWallets.find((t) => t.name === 'TrustWallet')
  return undefined
}

export function startWalletDiscovery(): Promise<EIP6963ProviderDetail[]> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve([])
      return
    }

    const providers: EIP6963ProviderDetail[] = []
    const handled = new Set<string>()

    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<EIP6963ProviderDetail>).detail
      if (!detail?.info?.uuid || handled.has(detail.info.uuid)) return
      handled.add(detail.info.uuid)
      providers.push(detail)
    }

    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))

    // 给钱包 1.5 秒时间广播自己
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce)
      discoveredProviders = providers
      resolve(providers)
    }, 1500)
  })
}

export async function getAvailableWallets(): Promise<DiscoveredWallet[]> {
  const providers = await startWalletDiscovery()

  // 兼容不支持 EIP-6963 的老钱包：扫描 window.ethereum
  if (typeof window !== 'undefined' && (window as unknown as { ethereum?: EIP1193Provider }).ethereum) {
    const win = window as unknown as { ethereum: EIP1193Provider }
    const candidates: EIP1193Provider[] = win.ethereum.providers ?? [win.ethereum]

    for (const provider of candidates) {
      const target = matchProviderToTarget(provider)
      if (!target) continue
      const already = providers.some((p) => p.info.rdns.toLowerCase() === target.rdns.toLowerCase())
      if (already) continue
      providers.push({
        info: {
          uuid: `${target.rdns}-legacy-${Math.random().toString(36).slice(2)}`,
          name: target.name,
          icon: '',
          rdns: target.rdns,
        },
        provider,
      })
    }
  }

  discoveredProviders = providers

  return targetWallets.map((target) => {
    const detail = providers.find(
      (p) => p.info.rdns.toLowerCase() === target.rdns.toLowerCase() || p.info.name === target.name
    )
    return { ...target, installed: !!detail, detail }
  })
}

function getTypedData(chainId: number, address: Address, nonce: string, timestamp: number) {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
      verifyingContract: '0x0000000000000000000000000000000000000000' as const,
    },
    types: {
      [EIP712_TYPE]: [
        { name: 'address', type: 'address' },
        { name: 'nonce', type: 'string' },
        { name: 'timestamp', type: 'uint256' },
      ],
    },
    primaryType: EIP712_TYPE,
    message: { address, nonce, timestamp },
  }
}

function generateNonce(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function connectAndSign(detail: EIP6963ProviderDetail, providerName: string): Promise<WalletLoginResult> {
  if (!detail?.provider?.request) {
    throw new WalletError('PROVIDER_NOT_FOUND', '未检测到该钱包扩展')
  }

  const provider = detail.provider
  console.log('[connectAndSign] provider', providerName, provider)

  let accounts: unknown
  let workingProvider: EIP1193Provider = provider
  try {
    accounts = await provider.request({ method: 'eth_requestAccounts' })
    console.log('[connectAndSign] accounts', accounts)
  } catch (err) {
    console.error('[connectAndSign] eth_requestAccounts failed', err)
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('User rejected') || msg.includes('rejected') || msg.includes('denied')) {
      throw new WalletError('USER_REJECTED', '用户拒绝了钱包连接')
    }
    // 兼容 EIP-6963 provider 不响应时,回退到 window.ethereum
    const winEth = typeof window !== 'undefined' ? (window as unknown as { ethereum?: EIP1193Provider }).ethereum : undefined
    if (winEth?.request && winEth !== provider) {
      try {
        accounts = await winEth.request({ method: 'eth_requestAccounts' })
        workingProvider = winEth
        console.log('[connectAndSign] fallback accounts', accounts)
      } catch (fallbackErr) {
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        throw new WalletError('CONNECT_FAILED', `连接钱包失败: ${fbMsg}`)
      }
    } else {
      throw new WalletError('CONNECT_FAILED', `连接钱包失败: ${msg}`)
    }
  }

  // 把实际能用的 provider 存下来,供后续链上交易使用
  setActiveProvider(workingProvider)

  const addressList = Array.isArray(accounts) ? (accounts as string[]) : []
  if (!addressList.length) {
    throw new WalletError('NO_ACCOUNTS', '钱包未返回地址,请确认已在 MetaMask 中解锁并授权本站点')
  }
  const address = addressList[0].toLowerCase() as Address

  let chainIdRaw: unknown
  try {
    chainIdRaw = await workingProvider.request({ method: 'eth_chainId' })
  } catch {
    chainIdRaw = '0x1'
  }
  const chainId = typeof chainIdRaw === 'string' ? Number.parseInt(chainIdRaw, 16) : 1

  const client = createWalletClient({
    account: address,
    chain: { id: chainId, name: 'Unknown', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } },
    transport: custom(workingProvider),
  })

  const nonce = generateNonce()
  const timestamp = Date.now()
  const typedData = getTypedData(chainId, address, nonce, timestamp)
  console.log('[connectAndSign] signing typed data', typedData)

  let signature: `0x${string}`
  try {
    signature = await client.signTypedData(typedData)
    console.log('[connectAndSign] signature', signature)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[connectAndSign] signTypedData failed', err)
    if (msg.includes('User rejected') || msg.includes('rejected') || msg.includes('denied')) {
      throw new WalletError('SIGN_REJECTED', '用户拒绝了签名')
    }
    throw new WalletError('SIGN_FAILED', `签名失败: ${msg}`)
  }

  return {
    address,
    signature,
    chainId,
    nonce,
    timestamp,
    provider: providerName,
  }
}
