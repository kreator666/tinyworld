import { useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import WalletModal from './WalletModal'

const navItems = [
  { to: '/backpack', label: '资产背包' },
  { to: '/plaza', label: '社交广场' },
  { to: '/chat', label: '消息' },
]

export default function NavBar() {
  const { connected, address, did, disconnect } = useAppStore()
  const handleDisconnect = () => {
    disconnect()
    nav('/')
  }
  const [showWallet, setShowWallet] = useState(false)
  const nav = useNavigate()

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
