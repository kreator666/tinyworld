import { useNavigate } from 'react-router-dom'
import type { PlazaUser } from '../types'
import { useAppStore } from '../store/appStore'
import { rarityDot } from './NFTCard'

// 社交广场用户 DID 卡
export default function DIDCard({ user }: { user: PlazaUser }) {
  const nav = useNavigate()
  const ensureChatWith = useAppStore((s) => s.ensureChatWith)
  const showToast = useAppStore((s) => s.showToast)

  const chatWithAI = () => {
    ensureChatWith(user.name, user.address, user.emoji, 'ai', user.aiTag)
    nav('/chat')
  }

  return (
    <div className="glass p-4 hover:border-neon-purple/50 transition">
      <div className="flex items-start gap-3">
        <div className={`w-16 h-20 rounded-xl bg-gradient-to-br ${user.gradient} grid place-items-center text-3xl shrink-0 border border-white/10`}>
          {user.emoji}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold truncate">{user.name}</span>
            <span className="tag border-neon-purple/40 text-neon-purple !text-[10px]">🤖 {user.aiTag}</span>
          </div>
          <div className="text-xs text-slate-500 font-mono mt-0.5">{user.address}</div>
          <div className="text-xs text-slate-400 mt-1 line-clamp-2">{user.bio}</div>
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-slate-500">
            <span>活跃度 {user.activity}%</span>
            <span>{rarityDot[user.rarest]} 最高{user.rarest}</span>
          </div>
        </div>
      </div>
      <div className="flex gap-2 mt-3">
        <button className="btn-ghost flex-1 !text-xs" onClick={() => showToast('已进入对方主页(演示版展示本人主页)')}>
          进入主页
        </button>
        <button className="btn-primary flex-1 !text-xs !py-2" onClick={chatWithAI}>
          🤖 和 AI 分身聊
        </button>
      </div>
    </div>
  )
}
