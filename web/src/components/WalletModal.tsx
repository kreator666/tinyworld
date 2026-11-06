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
import {
  buildNearLoginMessage,
  connectNearWalletById,
  detectNearWallets,
  nearLoginChallenge,
  stashNearLogin,
  NearWalletError,
} from '../lib/walletNear'
import { requestNonce, verifyAgentLogin } from '../lib/agentApi'
import { getAddress } from 'viem'
import { ensureTargetChain } from '../lib/chainDispatch'
import { useChainConfig } from '../store/chainConfigStore'
import { useChainStore } from '../store/chainStore'
import { useI18n } from '../i18n'

// 钱包选择弹窗: 通过 EIP-6963 发现钱包并走 SIWE 签名登录换取 JWT
// Solana 激活链时改为 Phantom 连接 + signMessage 登录(消息格式见 buildSolanaLoginMessage)
// NEAR 激活链时为 wallet-selector(MyNearWallet)连接 + login_challenge 链上挑战交易登录(见 buildNearLoginMessage)
export default function WalletModal({ onClose }: { onClose: () => void }) {
  const active = useChainConfig((s) => s.active)
  const connect = useAppStore((s) => s.connect)
  const showToast = useAppStore((s) => s.showToast)
  const updateLoginChainId = useAppStore((s) => s.updateLoginChainId)
  const refresh = useChainStore((s) => s.refresh)
  const nav = useNavigate()
  const { t } = useI18n()
  const family = active.family ?? 'evm'
  const isSolana = family === 'solana'
  const isNear = family === 'near'
  // NEAR 各钱包的安装探测(扩展注入全局对象);弹窗打开时快照一次即可
  const [nearWalletOptions] = useState(() => detectNearWallets())

  const NEAR_WALLET_ICONS: Record<string, string> = {
    'meteor-wallet': '☄️',
    nightly: '🌙',
    sender: '📨',
    'here-wallet': '📍',
  }

  const [wallets, setWallets] = useState<DiscoveredWallet[]>([])
  const [scanning, setScanning] = useState(true)
  const [actingWallet, setActingWallet] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'signing'>('idle')

  useEffect(() => {
    if (isSolana || isNear) {
      // Solana / NEAR 不在 EIP-6963 列表里:Solana 只有 Phantom 候选,NEAR 走 wallet-selector 弹窗
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
  }, [isSolana, isNear])

  // Solana(Phantom)登录:connect → /auth/nonce → signMessage → /auth/verify
  const handlePickSolana = async () => {
    if (!getSolanaProvider()) {
      showToast(t('wallet.noPhantom'))
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
      showToast(t('wallet.phantomConnected', { name: active.name }))
      try {
        await refresh(address)
      } catch {
        showToast(t('wallet.readFail'))
      }
      nav('/profile')
    } catch (err) {
      let message = t('wallet.loginFail')
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

  // NEAR 登录:按钱包分键直连(插件/网页分离按钮)→ /auth/nonce → 链上挑战交易 → /auth/verify。
  // 挑战交易可能整页重定向(网页钱包),发起前暂存上下文,跳回后由 App 启动时接住回调。
  const handlePickNear = async (walletId: string, walletName: string, forceWeb = false) => {
    setActingWallet(walletName)
    setPhase('connecting')
    try {
      const { address, providerName } = await connectNearWalletById(walletId, forceWeb)
      setPhase('signing')
      const { nonce } = await requestNonce(address)
      const message = buildNearLoginMessage(address, nonce, active.key)
      stashNearLogin({ message, address, nonce, providerName, chainId: active.chainId })
      const signature = await nearLoginChallenge(nonce)
      const { token } = await verifyAgentLogin(message, signature)
      connect(
        { address, signature, chainId: active.chainId, nonce, timestamp: Date.now(), provider: providerName },
        token,
        'near',
      )
      onClose()
      showToast(t('wallet.nearConnected', { name: walletName }))
      try {
        await refresh(address)
      } catch {
        showToast(t('wallet.readFail'))
      }
      nav('/profile')
    } catch (err) {
      let message = t('wallet.loginFail')
      if (err instanceof NearWalletError || err instanceof SolanaWalletError || err instanceof WalletError) {
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
      showToast(t('wallet.walletNotInstalled', { name: wallet.name }))
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
        updateLoginChainId(active.chainId)
        showToast(t('wallet.connectedSwitched', { name: wallet.name, chain: active.name }))
        await refresh(address)
      } catch (err) {
        showToast(t('wallet.switchOrReadFail', { name: active.name }))
      }
      nav('/profile')
    } catch (err) {
      // 切链失败不算致命:已登录,但链上功能不可用
      if (err instanceof Error && err.message.includes('wallet_switch')) {
        showToast(t('wallet.switchManual', { name: active.name }))
        onClose()
        return
      }
      let message = t('wallet.loginFail')
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
    if (phase === 'connecting') return t('wallet.phaseConnecting')
    if (phase === 'signing') return t('wallet.phaseSigning')
    return null
  }

  return (
    <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
      <div className="glass neon-border w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <span className="w-9 h-9 rounded-xl bg-neon-grad grid place-items-center text-xl">⬡</span>
          <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
        </div>
        <h3 className="text-lg font-semibold mt-2">{t('wallet.title')}</h3>
        <p className="text-xs text-slate-400 mb-4">{t('wallet.subtitle', { name: active.name })}</p>

        <div className="space-y-2">
          {isSolana ? (
            <button
              onClick={handlePickSolana}
              disabled={scanning || !!actingWallet}
              className="w-full flex items-center gap-3 glass px-4 py-3 transition disabled:opacity-60 hover:border-neon-purple/60"
            >
              <span className="text-xl">👻</span>
              <span className="font-medium">Phantom</span>
              {!getSolanaProvider() && <span className="ml-auto text-xs text-slate-500">{t('wallet.notInstalled')}</span>}
              {phaseText('Phantom') && (
                <span className="ml-auto text-xs text-neon-cyan animate-pulse">{phaseText('Phantom')}</span>
              )}
            </button>
          ) : isNear ? (
            <div className="space-y-2">
              {nearWalletOptions
                .filter((w) => w.installed)
                .map((w) => (
                  <button
                    key={w.id}
                    onClick={() => handlePickNear(w.id, w.name)}
                    disabled={scanning || !!actingWallet}
                    className="w-full flex items-center gap-3 glass px-4 py-3 transition disabled:opacity-60 hover:border-neon-purple/60"
                  >
                    <span className="text-xl">{NEAR_WALLET_ICONS[w.id] ?? 'Ⓝ'}</span>
                    <span className="font-medium">{t('wallet.extension', { name: w.name })}</span>
                    {phaseText(w.name) && (
                      <span className="ml-auto text-xs text-neon-cyan animate-pulse">{phaseText(w.name)}</span>
                    )}
                  </button>
                ))}
              {/* Meteor 网页通道:扩展未装/扩展故障时兜底,免安装 */}
              <button
                onClick={() => handlePickNear('meteor-wallet', t('wallet.meteorWebShort'), true)}
                disabled={scanning || !!actingWallet}
                className="w-full flex items-center gap-3 glass px-4 py-3 transition disabled:opacity-60 hover:border-neon-purple/60"
              >
                <span className="text-xl">🌐</span>
                <span className="font-medium">{t('wallet.meteorWeb')}</span>
                <span className="ml-auto text-xs text-slate-500">{t('wallet.noInstall')}</span>
                {phaseText(t('wallet.meteorWebShort')) && (
                  <span className="ml-auto text-xs text-neon-cyan animate-pulse">{phaseText(t('wallet.meteorWebShort'))}</span>
                )}
              </button>
              {nearWalletOptions.filter((w) => !w.installed && w.id !== 'meteor-wallet').length > 0 && (
                <p className="text-[10px] text-slate-500 pt-1">
                  {t('wallet.notInstalledList', {
                    names: nearWalletOptions
                      .filter((w) => !w.installed && w.id !== 'meteor-wallet')
                      .map((w) => w.name)
                      .join(' / '),
                  })}
                </p>
              )}
            </div>
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
                {!w.installed && <span className="ml-auto text-xs text-slate-500">{t('wallet.notInstalled')}</span>}
                {phaseText(w.name) && (
                  <span className="ml-auto text-xs text-neon-cyan animate-pulse">{phaseText(w.name)}</span>
                )}
              </button>
            ))
          )}
        </div>

        {scanning && (
          <p className="mt-4 text-center text-xs text-slate-400 animate-pulse">{t('wallet.scanning')}</p>
        )}
      </div>
    </div>
  )
}
