import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import {
  getAvailableWallets,
  connectProvider,
  buildAgentLoginMessage,
  type DiscoveredWallet,
  type EIP6963ProviderDetail,
  WalletError,
} from '../lib/wallet'
import {
  base58EncodeBytes,
  buildSolanaLoginMessage,
  connectSolanaWallet,
  getSolanaProvider,
  solanaSignMessage,
  SolanaWalletError,
} from '../lib/walletSolana'
import { requestNonce, verifyAgentLogin } from '../lib/agentApi'
import { getAddress } from 'viem'
import { ensureTargetChain } from '../lib/chainDispatch'
import { useChainConfig } from '../store/chainConfigStore'
import { useChainStore } from '../store/chainStore'

// 钱包选择弹窗: 通过 EIP-6963 发现钱包并走 SIWE 签名登录换取 JWT
// Solana 激活链时改为 Phantom 连接 + signMessage 登录(消息格式见 buildSolanaLoginMessage)
export default function WalletModal({ onClose }: { onClose: () => void }) {
  const active = useChainConfig((s) => s.active)
  const connect = useAppStore((s) => s.connect)
  const showToast = useAppStore((s) => s.showToast)
  const refresh = useChainStore((s) => s.refresh)
  const nav = useNavigate()
  const isSolana = (active.family ?? 'evm') === 'solana'

  const [wallets, setWallets] = useState<DiscoveredWallet[]>([])
  const [scanning, setScanning] = useState(true)
  const [actingWallet, setActingWallet] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'signing'>('idle')

  useEffect(() => {
    if (isSolana) {
      // Solana 链只有一个候选:Phantom(检测 window.solana)
      setWallets([])
      setScanning(false)
      return
    }
    let mounted = true
    getAvailableWallets().then((list) => {
      if (!mounted) return
      console.log('[WalletModal] discovered wallets', list)
      setWallets(list)
      setScanning(false)
    })
    return () => {
      mounted = false
    }
  }, [isSolana])

  // Solana(Phantom)登录:connect → /auth/nonce → signMessage → /auth/verify
  const handlePickSolana = async () => {
    if (!getSolanaProvider()) {
      showToast('Phantom 未安装,请先安装钱包扩展')
      window.open('https://phantom.com', '_blank')
      return
    }
    setActingWallet('Phantom')
    setPhase('connecting')
    try {
      const { address, providerName } = await connectSolanaWallet()
      setPhase('signing')
      const { nonce } = await requestNonce(address)
      const message = buildSolanaLoginMessage(address, nonce)
      const signatureBytes = await solanaSignMessage(new TextEncoder().encode(message))
      const signature = base58EncodeBytes(signatureBytes)
      const { token } = await verifyAgentLogin(message, signature)
      connect(
        { address, signature, chainId: active.chainId, nonce, timestamp: Date.now(), provider: providerName },
        token,
        'solana',
      )
      onClose()
      showToast(`Phantom 已连接(${active.name}),正在读取链上资产…`)
      try {
        await refresh(address)
      } catch {
        showToast('已连接钱包,但读取链上资产失败,请稍后重试')
      }
      nav('/profile')
    } catch (err) {
      let message = '登录失败,请重试'
      if (err instanceof SolanaWalletError || err instanceof WalletError) {
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

  const handlePick = async (wallet: DiscoveredWallet) => {
    console.log('[WalletModal] handlePick', wallet.name, wallet.installed, wallet.detail)
    if (!wallet.installed || !wallet.detail) {
      showToast(`${wallet.name} 未安装，请先安装钱包扩展`)
      return
    }

    setActingWallet(wallet.name)
    setPhase('connecting')

    try {
      const { address, chainId, client, providerName } = await connectProvider(wallet.detail, wallet.name)
      setPhase('signing')

      const { nonce, issuedAt } = await requestNonce(address)
      const message = buildAgentLoginMessage(address, nonce, chainId, issuedAt)
      const signature = await client.signMessage({ account: getAddress(address), message })
      const { token } = await verifyAgentLogin(message, signature)

      connect(
        {
          address,
          signature,
          chainId,
          nonce,
          timestamp: Date.now(),
          provider: providerName,
        },
        token,
        'evm',
      )
      onClose()

      // 强制切到目标链后刷新链上资产
      try {
        await ensureTargetChain()
        showToast(`${wallet.name} 已连接并切换到 ${active.name},正在读取链上资产…`)
        await refresh(address)
      } catch (err) {
        showToast(`已连接钱包,但未能切换到 ${active.name} 或读取链上资产,请手动切网络后再试`)
      }
      nav('/profile')
    } catch (err) {
      // 切链失败不算致命:已登录,但链上功能不可用
      if (err instanceof Error && err.message.includes('wallet_switch')) {
        showToast(`请手动切换到 ${active.name} 网络以使用链上资产功能`)
        onClose()
        return
      }
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
        <h3 className="text-lg font-semibold mt-2">连接钱包，唤醒你的 Agent</h3>
        <p className="text-xs text-slate-400 mb-4">签名即登录，Agent 身份与资产全部归属你的钱包地址</p>

        <div className="space-y-2">
          {isSolana ? (
            <button
              onClick={handlePickSolana}
              disabled={scanning || !!actingWallet}
              className="w-full flex items-center gap-3 glass px-4 py-3 transition disabled:opacity-60 hover:border-neon-purple/60"
            >
              <span className="text-xl">👻</span>
              <span className="font-medium">Phantom</span>
              {!getSolanaProvider() && <span className="ml-auto text-xs text-slate-500">未安装</span>}
              {phaseText('Phantom') && (
                <span className="ml-auto text-xs text-neon-cyan animate-pulse">{phaseText('Phantom')}</span>
              )}
            </button>
          ) : (
            wallets.map((w) => (
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
            ))
          )}
        </div>

        {scanning && (
          <p className="mt-4 text-center text-xs text-slate-400 animate-pulse">正在扫描已安装钱包…</p>
        )}
      </div>
    </div>
  )
}
