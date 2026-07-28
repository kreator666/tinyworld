import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAppStore } from './store/appStore'
import NavBar from './components/NavBar'
import LandingPage from './pages/LandingPage'
import MintWorkshop from './pages/MintWorkshop'
import ProfilePage from './pages/ProfilePage'
import PlazaPage from './pages/PlazaPage'
import ChatPage from './pages/ChatPage'
import BackpackPage from './pages/BackpackPage'
import GamePage from './pages/GamePage'

// 未连接钱包守卫:其余页面一律跳回首页
function Guard({ children }: { children: ReactNode }) {
  const connected = useAppStore((s) => s.connected)
  const loc = useLocation()
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

export default function App() {
  return (
    <HashRouter>
      <div className="min-h-full flex flex-col">
        <NavBar />
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/mint" element={<Guard><MintWorkshop /></Guard>} />
            <Route path="/profile" element={<Guard><ProfilePage /></Guard>} />
            <Route path="/plaza" element={<Guard><PlazaPage /></Guard>} />
            <Route path="/chat" element={<Guard><ChatPage /></Guard>} />
            <Route path="/backpack" element={<Guard><BackpackPage /></Guard>} />
            <Route path="/game" element={<GamePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <Toast />
      </div>
    </HashRouter>
  )
}
