import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import { useChainStore } from '../store/chainStore'
import { useChainConfig } from '../store/chainConfigStore'
import { ensureTargetChain, isWalletOnActiveChain } from '../lib/chainDispatch'
import { setActiveProvider } from '../lib/wallet'
import { clearActiveSolana, getSolanaProvider } from '../lib/walletSolana'
import { clearActiveNear } from '../lib/walletNear'
import { useI18n } from '../i18n'
import LanguageSwitcher from '../i18n/LanguageSwitcher'
import WalletModal from './WalletModal'

export default function NavBar() {
  const { t } = useI18n()
  const { connected, address, did, disconnect, login, showToast, walletKind, updateLoginChainId } = useAppStore()
  const chainStore = useChainStore()
  const { active, chains, setActive, hydrateFromApi, showTestnets, setShowTestnets } = useChainConfig()
  // 测试网开关关闭时链选择器只列主网
  const visibleChains = showTestnets ? chains : chains.filter((c) => !c.testnet)
  const wizardOpen = useAppStore((s) => s.wizardOpen)
  const setWizardOpen = useAppStore((s) => s.setWizardOpen)
  const [switching, setSwitching] = useState(false)
  const handleDisconnect = () => {
    disconnect()
    setActiveProvider(null)
    clearActiveSolana()
    clearActiveNear()
    chainStore.clear()
    nav('/')
  }
  const [showWallet, setShowWallet] = useState(false)
  const nav = useNavigate()
  const { isAdmin } = chainStore

  const navItems = [
    { to: '/profile', label: t('nav.profile') },
    { to: '/backpack', label: t('nav.backpack') },
    { to: '/plaza', label: t('nav.plaza') },
    { to: '/arena', label: t('nav.arena') },
    { to: '/chat', label: t('nav.chat') },
    // 生存模式仅 NEAR 链开放(后端按链实现,其他链隐藏入口)
    ...(active.family === 'near' ? [{ to: '/survival', label: t('nav.survival') }] : []),
  ]

  const onTargetChain = isWalletOnActiveChain(login, active)

  // 未连接钱包时点击导航:拦截跳转,提示连接钱包并弹出钱包选择
  const guardNav = (e: MouseEvent) => {
    if (connected) return
    e.preventDefault()
    showToast(t('navToast.connectFirst'))
    setShowWallet(true)
  }

  // 启动时从 agent 服务拉 chains 表(后端数据为准,本地兜底)
  useEffect(() => {
    hydrateFromApi()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (connected && onTargetChain && address) {
      chainStore.checkAdmin(address)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, onTargetChain, address])

  // 切链按钮:更新激活链 + 钱包跟随切换 + 重新拉链上数据(素材与链无关,只换合约)
  const switchTo = async (key: string) => {
    if (key === active.key) return
    const target = chains.find((c) => c.key === key)
    if (!target) return
    setSwitching(true)
    setActive(key as typeof active.key)
    chainStore.clear()
    // 多链提示:各链的 Agent/聊天记录互相独立,本期不支持跨链互动
    showToast(t('navToast.switched', { name: target.name }))
    try {
      const targetFamily = target.family ?? 'evm'
      if (targetFamily === 'solana') {
        // Solana 链:走 Phantom 连接流程(EVM/NEAR 会话与 Solana 不通用,需重新连接)
        if (!getSolanaProvider()) {
          showToast(t('navToast.noPhantom'))
          window.open('https://phantom.com', '_blank')
          setSwitching(false)
          return
        }
        if (!connected || walletKind !== 'solana') {
          disconnect()
          setActiveProvider(null)
          clearActiveSolana()
          clearActiveNear()
          setShowWallet(true)
          showToast(t('navToast.needPhantom'))
          setSwitching(false)
          return
        }
        if (address) await chainStore.refresh(address)
      } else if (targetFamily === 'near') {
        // NEAR 链:走 wallet-selector 连接流程(与其他链族会话不通用,需重新连接)
        if (!connected || walletKind !== 'near') {
          disconnect()
          setActiveProvider(null)
          clearActiveSolana()
          clearActiveNear()
          setShowWallet(true)
          showToast(t('navToast.needNear'))
          setSwitching(false)
          return
        }
        if (address) await chainStore.refresh(address)
      } else {
        if (connected && walletKind !== 'evm') {
          disconnect()
          setActiveProvider(null)
          clearActiveSolana()
          clearActiveNear()
          setShowWallet(true)
          showToast(t('navToast.needEvm'))
          setSwitching(false)
          return
        }
        if (connected) {
          await ensureTargetChain()
          updateLoginChainId(active.chainId)
          if (address) await chainStore.refresh(address)
        }
      }
      showToast(t('navToast.switchedTo', { name: useChainConfig.getState().active.name }))
    } catch {
      showToast(t('navToast.switchFail'))
    }
    setSwitching(false)
  }

  const switchChain = async () => {
    setSwitching(true)
    try {
      await ensureTargetChain()
      updateLoginChainId(active.chainId)
      if (address) await chainStore.refresh(address)
      // eslint-disable-next-line no-empty
    } catch {}
    setSwitching(false)
  }

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-white/10 bg-ink/70 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 h-16 flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2 shrink-0">
            <span className="w-8 h-8 rounded-lg bg-neon-grad grid place-items-center text-lg shadow-neon-purple">⬡</span>
            <span className="font-bold tracking-widest text-lg bg-neon-grad bg-clip-text text-transparent">
              AGENTVERSE
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-6 text-sm text-slate-300">
            {navItems.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                onClick={guardNav}
                className={({ isActive }) =>
                  isActive ? 'text-white border-b-2 border-neon-purple pb-0.5' : 'hover:text-white transition'
                }
              >
                {n.label}
              </NavLink>
            ))}
            {connected && !did && (
              <NavLink
                to="/mint"
                className={({ isActive }) =>
                  isActive ? 'text-white border-b-2 border-neon-purple pb-0.5' : 'hover:text-white transition'
                }
              >
                {t('nav.mint')}
              </NavLink>
            )}
            {isAdmin && (
              <NavLink
                to="/admin"
                className={({ isActive }) =>
                  isActive ? 'text-white border-b-2 border-neon-purple pb-0.5' : 'hover:text-white transition'
                }
              >
                {t('nav.admin')}
              </NavLink>
            )}
          </nav>

          <div className="flex items-center gap-3">
            {/* 新手引导开关:随时打开/关闭蒙板教学 */}
            <button
              onClick={() => setWizardOpen(!wizardOpen)}
              className={`tag !text-[10px] transition ${
                wizardOpen ? 'border-neon-purple/60 text-neon-purple' : 'border-white/15 text-slate-400 hover:text-slate-200'
              }`}
              title={t('nav.wizardOn')}
            >
              🎓 {t('nav.wizard')}
            </button>
            {/* 切链按钮:合约地址以后端 chains 表为准,前端本地数据兜底;测试网开关关闭时只列主网 */}
            <select
              className="glass !rounded-xl text-xs px-2 py-1.5 text-neon-cyan cursor-pointer bg-transparent"
              value={active.key}
              disabled={switching}
              onChange={(e) => switchTo(e.target.value)}
              title={t('nav.switchChain')}
            >
              {visibleChains.map((c) => (
                <option key={c.key} value={c.key} className="bg-ink">
                  ⛓ {c.name}
                </option>
              ))}
            </select>
            {/* 测试网开关:打开后链选择器列出全部网络(含测试网),关闭只留主网 */}
            <button
              onClick={() => setShowTestnets(!showTestnets)}
              className={`tag !text-[10px] transition ${
                showTestnets ? 'border-neon-purple/60 text-neon-purple' : 'border-white/15 text-slate-400 hover:text-slate-200'
              }`}
              title={showTestnets ? t('nav.testnetShown') : t('nav.testnetHidden')}
            >
              🧪 {t('nav.testnet')} {showTestnets ? t('nav.on') : t('nav.off')}
            </button>
            <LanguageSwitcher />
            {connected ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => nav(did || chainStore.tokenId > 0 ? '/profile' : '/mint')}
                  className="tag border-neon-purple/40 text-neon-cyan font-mono"
                  title={t('nav.myAddress')}
                >
                  🟢 {address?.slice(0, 6)}...{address?.slice(-4)}
                </button>
                {!onTargetChain && (
                  <button
                    onClick={switchChain}
                    disabled={switching}
                    className="tag border-amber-400/50 text-amber-300 text-[10px] hover:border-amber-300"
                    title={t('nav.switchTo', { name: active.name })}
                  >
                    ⚠ {switching ? t('nav.switching') : t('nav.switchWalletTo', { name: active.name })}
                  </button>
                )}
                <button onClick={handleDisconnect} className="btn-ghost !px-3 !py-1.5 text-xs">{t('nav.disconnect')}</button>
              </div>
            ) : (
              <button onClick={() => setShowWallet(true)} className="btn-primary">{t('nav.connect')}</button>
            )}
          </div>
        </div>
      </header>
      {showWallet && <WalletModal onClose={() => setShowWallet(false)} />}
    </>
  )
}
