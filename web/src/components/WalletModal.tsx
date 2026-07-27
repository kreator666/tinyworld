import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import {
  getAvailableWallets,
  connectAndSign,
  type DiscoveredWallet,
  type EIP6963ProviderDetail,
  WalletError,
} from '../lib/wallet'

// 钱包选择弹窗: 通过 EIP-6963 发现钱包并调起 EIP-712 签名登录
export default function WalletModal({ onClose }: { onClose: () => void }) {
  const connect = useAppStore((s) => s.connect)
  const showToast = useAppStore((s) => s.showToast)
  const nav = useNavigate()

  const [wallets, setWallets] = useState<DiscoveredWallet[]>([])
  const [scanning, setScanning] = useState(true)
  const [actingWallet, setActingWallet] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'signing'>('idle')

  useEffect(() => {
    let mounted = true
    getAvailableWallets().then((list) => {
      if (!mounted) return
      setWallets(list)
      setScanning(false)
    })
    return () => {
      mounted = false
    }
  }, [])

  const handlePick = async (wallet: DiscoveredWallet) => {
    if (!wallet.installed || !wallet.detail) {
      showToast(`${wallet.name} 未安装，请先安装钱包扩展`)
      return
    }

    setActingWallet(wallet.name)
    setPhase('connecting')

    try {
      const result = await connectAndSign(wallet.detail, wallet.name)
      setPhase('signing')
      connect({
        address: result.address,
        signature: result.signature,
        chainId: result.chainId,
        nonce: result.nonce,
        timestamp: result.timestamp,
        provider: result.provider,
      })
      onClose()
      showToast(`${wallet.name} 签名授权成功，已生成专属链上 DID 标识`)
      nav('/mint')
    } catch (err) {
      let message = '登录失败，请重试'
      if (err instanceof WalletError) {
        message = err.message
      } else if (err instanceof Error) {
        message = err.message
      }
      showToast(message)
    } finally {
      setActingWallet(null)
      setPhase('idle')
    }
  }

  const phaseText = (walletName: string) => {
    if (actingWallet !== walletName) return null
    if (phase === 'connecting') return '连接钱包中…'
    if (phase === 'signing') return '等待签名授权…'
    return null
  }

  return (
    <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
      <div className="glass neon-border w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <span className="w-9 h-9 rounded-xl bg-neon-grad grid place-items-center text-xl">⬡</span>
          <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
        </div>
        <h3 className="text-lg font-semibold mt-2">连接你的去中心化身份</h3>
        <p className="text-xs text-slate-400 mb-4">登录即生成专属链上 DID 标识，资产归属你的钱包地址</p>

        <div className="space-y-2">
          {wallets.map((w) => (
            <button
              key={w.name}
              onClick={() => handlePick(w)}
              disabled={scanning || !!actingWallet}
              className={`w-full flex items-center gap-3 glass px-4 py-3 transition disabled:opacity-60 ${
                w.installed ? 'hover:border-neon-purple/60' : 'opacity-50 cursor-not-allowed'
              }`}
            >
              <span className="text-xl">{w.icon}</span>
              <span className="font-medium">{w.name}</span>
              {!w.installed && <span className="ml-auto text-xs text-slate-500">未安装</span>}
              {phaseText(w.name) && (
                <span className="ml-auto text-xs text-neon-cyan animate-pulse">{phaseText(w.name)}</span>
              )}
            </button>
          ))}
        </div>

        {scanning && (
          <p className="mt-4 text-center text-xs text-slate-400 animate-pulse">正在扫描已安装钱包…</p>
        )}
      </div>
    </div>
  )
}
