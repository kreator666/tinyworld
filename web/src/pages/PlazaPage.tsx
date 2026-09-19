import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import DIDCard, { type PlazaAgent } from '../components/DIDCard'
import { fetchAgentPublic, fetchMintedAgents, TARGET_CHAIN_ID } from '../lib/chain'
import { getPartByLocalId } from '../data/equipmentCatalog'
import type { Rarity } from '../types'
import { rarityDot } from '../components/NFTCard'

const filters = [
  { key: 'latest', label: '最新铸造' },
  { key: 'rare', label: '稀有装备' },
  { key: 'follow', label: '关注列表' },
] as const

const rareOrder: Record<Rarity, number> = { 传说: 0, 史诗: 1, 稀有: 2, 普通: 3 }

// 页面 4:社交广场(用户列表全部来自链上已铸造的 Agent)
export default function PlazaPage() {
  const [filter, setFilter] = useState<(typeof filters)[number]['key']>('latest')
  const [agents, setAgents] = useState<PlazaAgent[]>([])
  const [loading, setLoading] = useState(false)
  const nav = useNavigate()
  const { connected, login, following, toggleFollow, showToast } = useAppStore()

  const isSepolia = login?.chainId === TARGET_CHAIN_ID

  useEffect(() => {
    if (!connected || !isSepolia) return
    setLoading(true)
    fetchMintedAgents()
      .then((list) => Promise.all(list.map((a) => fetchAgentPublic(a.tokenId))))
      .then((list) =>
        setAgents(
          list.map((a) => {
            // 最高稀有度由链上装备推导
            const rarities = Object.values(a.equipped)
              .map((id) => (id ? getPartByLocalId(id)?.rarity : undefined))
              .filter((r): r is Rarity => !!r)
            const rarest = rarities.sort((x, y) => rareOrder[x] - rareOrder[y])[0] ?? null
            return { tokenId: a.tokenId, name: a.name, owner: a.owner, bio: a.bio, equipped: a.equipped, rarest }
          }),
        ),
      )
      .catch((e) => console.warn('读取链上 Agent 列表失败:', e))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, isSepolia])

  const users = useMemo(() => {
    const list = [...agents]
    switch (filter) {
      case 'latest':
        return list.sort((a, b) => b.tokenId - a.tokenId) // tokenId 越大越新
      case 'rare':
        return list.sort((a, b) => (a.rarest ? rareOrder[a.rarest] : 99) - (b.rarest ? rareOrder[b.rarest] : 99))
      case 'follow':
        return list.filter((u) => following.includes(`agent-${u.tokenId}`))
    }
  }, [filter, agents, following])

  // 侧边栏:关注的 Agent + 最新铸造榜
  const followedAgents = useMemo(() => agents.filter((a) => following.includes(`agent-${a.tokenId}`)), [agents, following])
  const latestTop = useMemo(() => [...agents].sort((a, b) => b.tokenId - a.tokenId).slice(0, 5), [agents])

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h2 className="text-2xl font-bold mb-1">社交广场</h2>
      <p className="text-sm text-slate-400 mb-5">发现其他人的 Agent,和它们互动、聊天、建立连接</p>

      {!connected || !isSepolia ? (
        <div className="glass p-10 text-center text-slate-500 max-w-md">
          {connected ? '⚠️ 请切换到 Sepolia 网络以查看链上 Agent' : '请先连接钱包以查看链上 Agent'}
        </div>
      ) : (
        <>
          {/* 筛选栏 */}
          <div className="flex gap-2 mb-6 flex-wrap">
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-4 py-2 rounded-xl text-sm transition ${
                  filter === f.key ? 'bg-neon-grad text-white shadow-neon-purple' : 'glass text-slate-300 hover:border-neon-purple/50'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="grid lg:grid-cols-[1fr_280px] gap-6">
            {/* 卡片流 */}
            <div className="grid sm:grid-cols-2 gap-4 content-start">
              {loading && agents.length === 0 && (
                <div className="glass p-10 text-center text-slate-500 sm:col-span-2 animate-pulse">正在从链上读取 Agent…</div>
              )}
              {!loading && users.length === 0 && (
                <div className="glass p-10 text-center text-slate-500 sm:col-span-2">
                  {filter === 'follow' ? '还没有关注任何 Agent,去逛逛最新铸造吧' : '链上还没有铸造的 Agent'}
                </div>
              )}
              {users.map((u) => <DIDCard key={u.tokenId} agent={u} />)}
            </div>

            {/* 侧边推荐栏 */}
            <aside className="space-y-4 content-start">
              <div className="glass p-4">
                <h3 className="font-semibold text-sm mb-3">👥 关注的 Agent</h3>
                {followedAgents.length === 0 && <p className="text-xs text-slate-500">暂无关注,进对方主页点 + 关注</p>}
                <div className="space-y-2.5">
                  {followedAgents.map((u) => (
                    <button key={u.tokenId} className="w-full flex items-center gap-2.5 text-left" onClick={() => nav(`/profile/${u.tokenId}`)}>
                      <span className="w-8 h-8 rounded-lg bg-neon-grad/20 grid place-items-center">🤖</span>
                      <div className="min-w-0">
                        <div className="text-sm truncate">{u.name}</div>
                        <div className="text-[10px] text-slate-500 font-mono">#{u.tokenId}</div>
                      </div>
                      <span
                        className="ml-auto text-xs text-slate-500 hover:text-white"
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleFollow(`agent-${u.tokenId}`)
                          showToast('已取消关注')
                        }}
                      >
                        ✕
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="glass p-4">
                <h3 className="font-semibold text-sm mb-3">🔥 最新铸造榜</h3>
                {latestTop.length === 0 && <p className="text-xs text-slate-500">暂无数据</p>}
                <div className="space-y-2">
                  {latestTop.map((r, i) => (
                    <button key={r.tokenId} className="w-full flex items-center gap-2.5 text-sm text-left" onClick={() => nav(`/profile/${r.tokenId}`)}>
                      <span className={`w-5 text-center font-bold ${i < 3 ? 'text-amber-300' : 'text-slate-500'}`}>{i + 1}</span>
                      <span className="truncate">{r.name}</span>
                      <span className="ml-auto text-xs text-neon-cyan font-mono">
                        {r.rarest ? `${rarityDot[r.rarest]} ${r.rarest}` : `#${r.tokenId}`}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </aside>
          </div>
        </>
      )}
    </div>
  )
}
