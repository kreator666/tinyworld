import { useEffect, useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import { useChainStore } from '../store/chainStore'
import { ensureSepolia, TARGET_CHAIN_ID } from '../lib/chain'
import { setActiveProvider } from '../lib/wallet'
import WalletModal from './WalletModal'

const navItems = [
  { to: '/backpack', label: '资产背包' },
  { to: '/plaza', label: '社交广场' },
  { to: '/chat', label: '消息' },
]

export default function NavBar() {
  const { connected, address, did, disconnect, login } = useAppStore()
  const chainStore = useChainStore()
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

  const isSepolia = login?.chainId === TARGET_CHAIN_ID

  useEffect(() => {
    if (connected && isSepolia && address) {
      chainStore.checkAdmin(address as `0x${string}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, isSepolia, address])

  const switchChain = async () => {
    setSwitching(true)
    try {
      await ensureSepolia()
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
              DID AI VERSE
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
            {did && (
              <NavLink
                to="/profile"
                className={({ isActive }) =>
                  isActive ? 'text-white border-b-2 border-neon-purple pb-0.5' : 'hover:text-white transition'
                }
              >
                我的 DID
              </NavLink>
            )}
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
            <button className="text-slate-400 hover:text-white transition" title="搜索">🔍</button>
            {connected ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => nav(did ? '/profile' : '/mint')}
                  className="tag border-neon-purple/40 text-neon-cyan font-mono"
                  title="我的钱包地址"
                >
                  🟢 {address?.slice(0, 6)}...{address?.slice(-4)}
                </button>
                {isSepolia ? (
                  <span className="tag border-neon-cyan/40 text-neon-cyan text-[10px]" title="已连接 Sepolia 测试网">✓ Sepolia</span>
                ) : (
                  <button
                    onClick={switchChain}
                    disabled={switching}
                    className="tag border-amber-400/50 text-amber-300 text-[10px] hover:border-amber-300"
                    title="切换到 Sepolia 以使用链上功能"
                  >
                    ⚠ {switching ? '切链中' : '切到 Sepolia'}
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
