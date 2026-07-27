import { useState } from 'react'
import type { NFTCategory } from '../types'
import { useAppStore } from '../store/appStore'
import NFTCard from '../components/NFTCard'

const tabs: { key: NFTCategory | 'did'; label: string }[] = [
  { key: 'did', label: 'DID 主身份' },
  { key: 'head', label: '头部藏品' },
  { key: 'body', label: '身体' },
  { key: 'accessory', label: '配饰' },
  { key: 'pet', label: '宠物' },
]

// 页面 6:资产背包
export default function BackpackPage() {
  const { inventory, did, equip, showToast } = useAppStore()
  const [tab, setTab] = useState<(typeof tabs)[number]['key']>('did')

  const list = tab === 'did' ? [] : inventory.filter((i) => i.category === tab)
  const isWorn = (id: string, cat: NFTCategory) => did?.equipped[cat] === id

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h2 className="text-2xl font-bold mb-1">资产背包</h2>
      <p className="text-sm text-slate-400 mb-5">你的全部身份 NFT 藏品,穿戴后主页纸娃娃实时更新</p>

      {/* 分类标签 */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-xl text-sm transition ${
              tab === t.key ? 'bg-neon-grad text-white shadow-neon-purple' : 'glass text-slate-300 hover:border-neon-purple/50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'did' ? (
        // DID 主身份 NFT
        did ? (
          <div className="glass neon-border p-5 max-w-md">
            <div className="flex items-center gap-4">
              <span className="w-14 h-14 rounded-xl bg-neon-grad grid place-items-center text-2xl shadow-neon-purple">🪪</span>
              <div>
                <div className="font-semibold">{did.name} · 主身份 NFT</div>
                <div className="text-xs text-slate-500 font-mono mt-0.5">{did.contract}</div>
              </div>
            </div>
            <div className="mt-4 space-y-1.5 text-xs text-slate-400 font-mono">
              <div>chain: {did.chain}</div>
              <div>minted: {did.mintedAt}</div>
              <div>owner: {did.address}</div>
              <div>数量: 1(专属,不可转让)</div>
            </div>
          </div>
        ) : (
          <div className="glass p-10 text-center text-slate-500 max-w-md">尚未铸造 DID 主身份 NFT</div>
        )
      ) : list.length === 0 ? (
        <div className="glass p-10 text-center text-slate-500">该分类下暂无藏品,去铸造工坊挑选吧</div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {list.map((i) => (
            <div key={i.id} className="relative">
              <NFTCard item={i} />
              <div className="mt-2 space-y-1.5">
                <div className="text-[11px] text-slate-500 font-mono truncate">hash: {i.hash}</div>
                <div className="text-[11px] text-slate-500">持有数量:{i.count ?? 1}</div>
                <div className="flex gap-2">
                  <button
                    className="btn-ghost flex-1 !text-xs !py-1.5"
                    onClick={() => showToast(`已挂单「${i.name}」(演示)`)}
                  >
                    交易
                  </button>
                  <button
                    className={`flex-1 !text-xs !py-1.5 rounded-xl transition ${
                      isWorn(i.id, i.category)
                        ? 'bg-emerald-500/20 border border-emerald-400/50 text-emerald-300'
                        : 'btn-primary'
                    }`}
                    disabled={!did}
                    onClick={() => {
                      equip(i.category, i.id)
                      showToast(`已穿戴「${i.name}」,主页纸娃娃已更新`)
                    }}
                  >
                    {isWorn(i.id, i.category) ? '✓ 穿戴中' : '穿戴'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {!did && tab !== 'did' && (
        <p className="text-xs text-slate-500 mt-4">💡 铸造 DID 身份后即可穿戴配件</p>
      )}
    </div>
  )
}
