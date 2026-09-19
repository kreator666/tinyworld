import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import { rarityDot } from './NFTCard'
import PaperDoll from './PaperDoll'
import type { Equipped, Rarity } from '../types'

export interface PlazaAgent {
  tokenId: number
  name: string
  owner: string
  bio: string
  equipped: Equipped
  rarest: Rarity | null // 由链上装备推导
}

// 社交广场 Agent 卡:数据全部来自链上(fetchAgentPublic)
export default function DIDCard({ agent }: { agent: PlazaAgent }) {
  const nav = useNavigate()
  const ensureChatWith = useAppStore((s) => s.ensureChatWith)

  const chatWithAI = () => {
    // 带 agentTokenId:聊天页会用对方的链上人格走真实 agent/ 服务
    ensureChatWith(agent.name, agent.owner.slice(0, 6) + '...' + agent.owner.slice(-4), '🤖', 'ai', '链上 Agent', {
      agentTokenId: agent.tokenId,
    })
    nav('/chat')
  }

  return (
    <div className="glass p-4 hover:border-neon-purple/50 transition">
      <div className="flex items-start gap-3">
        <div className="shrink-0">
          <PaperDoll equipped={agent.equipped} size="sm" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold truncate">{agent.name}</span>
            <span className="tag border-neon-cyan/40 text-neon-cyan !text-[10px]">#{agent.tokenId}</span>
          </div>
          <div className="text-xs text-slate-500 font-mono mt-0.5">
            {agent.owner.slice(0, 6)}...{agent.owner.slice(-4)}
          </div>
          <div className="text-xs text-slate-400 mt-1 line-clamp-2">{agent.bio || '这个 Agent 还没有写简介'}</div>
          {agent.rarest && (
            <div className="text-[11px] text-slate-500 mt-1.5">
              {rarityDot[agent.rarest]} 最高{agent.rarest}装备
            </div>
          )}
        </div>
      </div>
      <div className="flex gap-2 mt-3">
        <button className="btn-ghost flex-1 !text-xs" onClick={() => nav(`/profile/${agent.tokenId}`)}>
          进入主页
        </button>
        <button className="btn-primary flex-1 !text-xs !py-2" onClick={chatWithAI}>
          🤖 和 Agent 聊
        </button>
      </div>
    </div>
  )
}
