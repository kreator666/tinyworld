import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'

const wallets = [
  { name: 'MetaMask', icon: '🦊' },
  { name: 'Coinbase', icon: '🔵' },
  { name: 'OKX', icon: '⭕' },
  { name: 'TrustWallet', icon: '🛡️' },
]

// 钱包选择弹窗:模拟签名授权流程
export default function WalletModal({ onClose }: { onClose: () => void }) {
  const connect = useAppStore((s) => s.connect)
  const showToast = useAppStore((s) => s.showToast)
  const nav = useNavigate()
  const [signing, setSigning] = useState<string | null>(null)

  const handlePick = (name: string) => {
    setSigning(name)
    // 模拟拉起钱包签名授权
    setTimeout(() => {
      connect(name)
      onClose()
      showToast(`${name} 授权成功,已生成专属链上 DID 标识`)
      nav('/mint')
    }, 1500)
  }

  return (
    <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
      <div className="glass neon-border w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <span className="w-9 h-9 rounded-xl bg-neon-grad grid place-items-center text-xl">⬡</span>
          <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
        </div>
        <h3 className="text-lg font-semibold mt-2">连接你的去中心化身份</h3>
        <p className="text-xs text-slate-400 mb-4">登录即生成专属链上 DID 标识,资产归属你的钱包地址</p>
        <div className="space-y-2">
          {wallets.map((w) => (
            <button
              key={w.name}
              onClick={() => handlePick(w.name)}
              disabled={!!signing}
              className="w-full flex items-center gap-3 glass px-4 py-3 hover:border-neon-purple/60 transition disabled:opacity-60"
            >
              <span className="text-xl">{w.icon}</span>
              <span className="font-medium">{w.name}</span>
              {signing === w.name && <span className="ml-auto text-xs text-neon-cyan animate-pulse">签名授权中…</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
