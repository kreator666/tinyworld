import { useState } from 'react'
import { useAppStore } from '../store/appStore'
import WalletModal from '../components/WalletModal'
import PaperDoll from '../components/PaperDoll'

const sellingPoints = [
  { icon: '👛', title: '钱包一键登录', desc: '去中心化 DID 身份,数据归你所有' },
  { icon: '🧩', title: '模块化 NFT 纸娃娃', desc: '头像 / 皮肤 / 装备均为独立链上资产' },
  { icon: '🤖', title: '自定义 AI 人格', desc: '自动社交、聊天、互动,分身替你在线' },
]

// 页面 1:首页·钱包登录页
export default function LandingPage() {
  const [showWallet, setShowWallet] = useState(false)
  const connected = useAppStore((s) => s.connected)

  return (
    <div className="flex flex-col">
      {/* 主视觉区 */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -left-32 top-10 w-96 h-96 rounded-full bg-neon-purple/20 blur-3xl" />
          <div className="absolute -right-32 bottom-0 w-96 h-96 rounded-full bg-neon-cyan/15 blur-3xl" />
        </div>

        <div className="relative mx-auto max-w-6xl px-4 py-20 grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <h1 className="text-4xl md:text-5xl font-bold leading-tight">
              铸造你的<span className="bg-neon-grad bg-clip-text text-transparent">链上数字分身</span>
              <br />AI 替你社交
            </h1>
            <div className="mt-8 space-y-4">
              {sellingPoints.map((s) => (
                <div key={s.title} className="flex items-center gap-3">
                  <span className="w-10 h-10 rounded-xl glass grid place-items-center text-lg shrink-0">{s.icon}</span>
                  <div>
                    <span className="font-medium">✅ {s.title}</span>
                    <span className="text-slate-400 text-sm ml-2">{s.desc}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-10">
              {!connected && (
                <button onClick={() => setShowWallet(true)} className="btn-primary text-lg !px-8 !py-3.5 animate-pulse-ring">
                  连接加密钱包
                </button>
              )}
              <p className="mt-4 text-xs text-slate-500">
                登录即生成专属链上 DID 标识,所有 NFT 资产归属你的钱包地址
              </p>
            </div>
          </div>

          {/* 装饰纸娃娃 */}
          <div className="hidden lg:flex justify-center">
            <div className="glass neon-border p-8 shadow-neon-purple">
              <PaperDoll equipped={{ head: 'head-3', body: 'body-1', accessory: 'acc-1', pet: 'pet-1' }} size="lg" />
              <div className="mt-4 text-center text-sm text-slate-400">
                <span className="tag border-neon-purple/40 text-neon-purple mr-2">🤖 AI 分身在线</span>
                <span className="tag border-neon-cyan/40 text-neon-cyan">链上身份 NFT</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 页脚 */}
      <footer className="border-t border-white/10 mt-auto">
        <div className="mx-auto max-w-6xl px-4 py-8 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-slate-500">
          <span>© 2026 DID AI Verse · Web3 去中心化身份社交</span>
          <div className="flex gap-6">
            <a className="hover:text-neon-purple transition cursor-pointer">链上协议说明</a>
            <a className="hover:text-neon-purple transition cursor-pointer">DID 白皮书</a>
            <a className="hover:text-neon-purple transition cursor-pointer">社交社区入口</a>
          </div>
        </div>
      </footer>

      {showWallet && <WalletModal onClose={() => setShowWallet(false)} />}
    </div>
  )
}
