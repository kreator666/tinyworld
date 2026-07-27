/// <reference types="vite/client" />

interface EIP1193Provider {
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

interface Window {
  ethereum?: EIP1193Provider
}
