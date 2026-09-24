import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useAppStore } from './store/appStore'
import { useChainStore } from './store/chainStore'
import { getActiveProvider, setActiveProvider } from './lib/wallet'
import NavBar from './components/NavBar'
import LandingPage from './pages/LandingPage'
import MintWorkshop from './pages/MintWorkshop'
import ProfilePage from './pages/ProfilePage'
import PlazaPage from './pages/PlazaPage'
import ChatPage from './pages/ChatPage'
import BackpackPage from './pages/BackpackPage'
import GamePage from './pages/GamePage'
import AdminPage from './pages/AdminPage'
import MyAgentPage from './pages/MyAgentPage'

// 未连接钱包守卫:其余页面一律跳回首页
function Guard({ children }: { children: ReactNode }) {
  const connected = useAppStore((s) => s.connected)
  const hydrated = useAppStore((s) => s.hydrated)
  const loc = useLocation()
  // 等待持久化恢复完成后再判断登录态,避免刷新/链切换后错误跳回首页
  if (!hydrated) {
    return (
      <div className="flex h-screen w-full items-center justify-center text-white/70">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    )
  }
  if (!connected) return <Navigate to="/" state={{ from: loc.pathname }} replace />
  return <>{children}</>
}

function Toast() {
  const toast = useAppStore((s) => s.toast)
  if (!toast) return null
  return (
    <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] glass neon-border px-5 py-3 text-sm shadow-neon-purple">
      {toast}
    </div>
  )
}

function WalletEvents() {
  const { connected, address, disconnect } = useAppStore()
  const clear = useChainStore((s) => s.clear)
  const nav = useNavigate()

  useEffect(() => {
    const provider = getActiveProvider()
    if (!provider?.on) return

    const onAccountsChanged = (accounts: unknown) => {
      const list = Array.isArray(accounts) ? (accounts as string[]) : []
      if (list.length === 0 || list[0]?.toLowerCase() !== address?.toLowerCase()) {
        setActiveProvider(null)
        disconnect()
        clear()
        nav('/')
      }
    }
    const onChainChanged = () => {
      // 链已切换,重新加载以保证状态干净
      window.location.reload()
    }

    provider.on('accountsChanged', onAccountsChanged)
    provider.on('chainChanged', onChainChanged)
    return () => {
      provider.removeListener?.('accountsChanged', onAccountsChanged)
      provider.removeListener?.('chainChanged', onChainChanged)
    }
  }, [connected, address, disconnect, clear, nav])

  return null
}

export default function App() {
  const setHydrated = useAppStore((s) => s.setHydrated)

  useEffect(() => {
    // 持久化恢复默认同步完成,用 useEffect 标记 hydrated 可确保 Guard 不会永远等待
    setHydrated(true)
  }, [setHydrated])

  return (
    <HashRouter>
      <div className="min-h-full flex flex-col">
        <NavBar />
        <WalletEvents />
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/mint" element={<Guard><MintWorkshop /></Guard>} />
            <Route path="/profile" element={<Guard><ProfilePage /></Guard>} />
            <Route path="/profile/:tokenId" element={<Guard><ProfilePage /></Guard>} />
            <Route path="/assistant" element={<Guard><MyAgentPage /></Guard>} />
            <Route path="/plaza" element={<Guard><PlazaPage /></Guard>} />
            <Route path="/chat" element={<Guard><ChatPage /></Guard>} />
            <Route path="/backpack" element={<Guard><BackpackPage /></Guard>} />
            <Route path="/admin" element={<Guard><AdminPage /></Guard>} />
            <Route path="/game" element={<GamePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <Toast />
      </div>
    </HashRouter>
  )
}
