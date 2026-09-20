import { useEffect, useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import { useChainStore } from '../store/chainStore'
import { useChainConfig } from '../store/chainConfigStore'
import { ensureTargetChain } from '../lib/chain'
import { setActiveProvider } from '../lib/wallet'
import WalletModal from './WalletModal'

const navItems = [
  { to: '/profile', label: '个人主页' },
  { to: '/backpack', label: '资产背包' },
  { to: '/plaza', label: '社交广场' },
  { to: '/chat', label: '消息' },
]

export default function NavBar() {
  const { connected, address, did, disconnect, login, showToast } = useAppStore()
  const chainStore = useChainStore()
  const { active, chains, setActive, hydrateFromApi } = useChainConfig()
  const [switching, setSwitching] = useState(false)
  const handleDisconnect = () => {
    disconnect()
    setActiveProvider(null)
    chainStore.clear()
    nav('/')
  }
  const [showWallet, setShowWallet] = useState(false)
  const nav = useNavigate()
  const { isAdmin } = chainStore

  const onTargetChain = login?.chainId === active.chainId

  // 启动时从 agent 服务拉 chains 表(后端数据为准,本地兜底)
  useEffect(() => {
    hydrateFromApi()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (connected && onTargetChain && address) {
      chainStore.checkAdmin(address as `0x${string}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, onTargetChain, address])

  // 切链按钮:更新激活链 + 钱包跟随切换 + 重新拉链上数据(素材与链无关,只换合约)
  const switchTo = async (key: string) => {
    if (key === active.key) return
    setSwitching(true)
    setActive(key as typeof active.key)
    chainStore.clear()
    try {
      if (connected) {
        await ensureTargetChain()
        if (address) await chainStore.refresh(address as `0x${string}`)
      }
      showToast(`已切换到 ${useChainConfig.getState().active.name}`)
    } catch {
      showToast('已切换目标链,但钱包切链失败,请手动切换')
    }
    setSwitching(false)
  }

  const switchChain = async () => {
    setSwitching(true)
    try {
      await ensureTargetChain()
      if (address) await chainStore.refresh(address as `0x${string}`)
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
                铸造工坊
              </NavLink>
            )}
            {isAdmin && (
              <NavLink
                to="/admin"
                className={({ isActive }) =>
                  isActive ? 'text-white border-b-2 border-neon-purple pb-0.5' : 'hover:text-white transition'
                }
              >
                管理员
              </NavLink>
            )}
          </nav>

          <div className="flex items-center gap-3">
            {/* 切链按钮:合约地址以后端 chains 表为准,前端本地数据兜底 */}
            <select
              className="glass !rounded-xl text-xs px-2 py-1.5 text-neon-cyan cursor-pointer bg-transparent"
              value={active.key}
              disabled={switching}
              onChange={(e) => switchTo(e.target.value)}
              title="切换目标链(素材全链一致,仅切换合约)"
            >
              {chains.map((c) => (
                <option key={c.key} value={c.key} className="bg-ink">
                  ⛓ {c.name}
                </option>
              ))}
            </select>
            {connected ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => nav(did || chainStore.tokenId > 0 ? '/profile' : '/mint')}
                  className="tag border-neon-purple/40 text-neon-cyan font-mono"
                  title="我的钱包地址"
                >
                  🟢 {address?.slice(0, 6)}...{address?.slice(-4)}
                </button>
                {!onTargetChain && (
                  <button
                    onClick={switchChain}
                    disabled={switching}
                    className="tag border-amber-400/50 text-amber-300 text-[10px] hover:border-amber-300"
                    title={`钱包切换到 ${active.name} 以使用链上功能`}
                  >
                    ⚠ {switching ? '切链中' : `钱包切到 ${active.name}`}
                  </button>
                )}
                <button onClick={handleDisconnect} className="btn-ghost !px-3 !py-1.5 text-xs">断开</button>
              </div>
            ) : (
              <button onClick={() => setShowWallet(true)} className="btn-primary">连接钱包</button>
            )}
          </div>
        </div>
      </header>
      {showWallet && <WalletModal onClose={() => setShowWallet(false)} />}
    </>
  )
}
