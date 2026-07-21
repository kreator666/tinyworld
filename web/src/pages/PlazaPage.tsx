import { useMemo, useState } from 'react'
import { plazaUsers, hotRanking } from '../mock/data'
import { useAppStore } from '../store/appStore'
import DIDCard from '../components/DIDCard'

const filters = [
  { key: 'latest', label: '最新铸造' },
  { key: 'active', label: '高活跃 AI' },
  { key: 'rare', label: '稀有装备' },
  { key: 'follow', label: '关注列表' },
] as const

const rareOrder = { 传说: 0, 史诗: 1, 稀有: 2, 普通: 3 }

// 页面 4:社交广场
export default function PlazaPage() {
  const [filter, setFilter] = useState<(typeof filters)[number]['key']>('latest')
  const following = useAppStore((s) => s.following)

  const users = useMemo(() => {
    const list = [...plazaUsers]
    switch (filter) {
      case 'latest':
        return list.sort((a, b) => b.mintedAt.localeCompare(a.mintedAt))
      case 'active':
        return list.sort((a, b) => b.activity - a.activity)
      case 'rare':
        return list.sort((a, b) => rareOrder[a.rarest] - rareOrder[b.rarest])
      case 'follow':
        return list.filter((u) => following.includes(u.id))
    }
  }, [filter, following])

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h2 className="text-2xl font-bold mb-1">社交广场</h2>
      <p className="text-sm text-slate-400 mb-5">发现其他用户的 DID 身份,和他们的 AI 分身互动</p>

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
          {users.length === 0 && (
            <div className="glass p-10 text-center text-slate-500 sm:col-span-2">
              还没有关注任何 DID,去逛逛最新铸造吧
            </div>
          )}
          {users.map((u) => <DIDCard key={u.id} user={u} />)}
        </div>

        {/* 侧边推荐栏 */}
        <aside className="space-y-4 content-start">
          <div className="glass p-4">
            <h3 className="font-semibold text-sm mb-3">👥 好友 DID</h3>
            <div className="space-y-2.5">
              {plazaUsers.slice(0, 3).map((u) => (
                <div key={u.id} className="flex items-center gap-2.5">
                  <span className={`w-8 h-8 rounded-lg bg-gradient-to-br ${u.gradient} grid place-items-center`}>{u.emoji}</span>
                  <div className="min-w-0">
                    <div className="text-sm truncate">{u.name}</div>
                    <div className="text-[10px] text-slate-500 font-mono">{u.address}</div>
                  </div>
                  <span className="ml-auto w-2 h-2 rounded-full bg-emerald-400" title="AI 分身在线" />
                </div>
              ))}
            </div>
          </div>

          <div className="glass p-4">
            <h3 className="font-semibold text-sm mb-3">🔥 热门链上身份 NFT 榜单</h3>
            <div className="space-y-2">
              {hotRanking.map((r) => (
                <div key={r.rank} className="flex items-center gap-2.5 text-sm">
                  <span className={`w-5 text-center font-bold ${r.rank <= 3 ? 'text-amber-300' : 'text-slate-500'}`}>{r.rank}</span>
                  <span className="truncate">{r.name}</span>
                  <span className="ml-auto text-xs text-neon-cyan font-mono">{r.heat}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
