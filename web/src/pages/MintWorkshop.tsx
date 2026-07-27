import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ChainType, Equipped, NFTCategory } from '../types'
import { nftLibrary } from '../mock/data'
import { useAppStore, emptyEquipped } from '../store/appStore'
import PaperDoll from '../components/PaperDoll'
import NFTCard from '../components/NFTCard'

const tabs: { key: NFTCategory; label: string; desc: string }[] = [
  { key: 'head', label: '头部', desc: '发型 / 头盔 / 面具' },
  { key: 'body', label: '身体', desc: '服装 / 盔甲 / 躯干主体' },
  { key: 'accessory', label: '配饰', desc: '披风 / 徽章 / 手持 / 光翼' },
  { key: 'pet', label: '宠物', desc: '跟随小伙伴(显示在人物身后)' },
]

const takenNames = ['satoshi', 'vitalik', 'aiko_02', 'neonhunter'] // 模拟已被占用名称
const chains: ChainType[] = ['Polygon', 'BSC', 'ETH']
const GAS_FEE = 0.0042

type MintPhase = 'idle' | 'signing' | 'onchain' | 'done'

// 页面 2:身份铸造工坊
export default function MintWorkshop() {
  const nav = useNavigate()
  const { did, mintDID, addToInventory, showToast } = useAppStore()

  const [tab, setTab] = useState<NFTCategory>('head')
  const [equipped, setEquipped] = useState<Equipped>(
    did?.equipped ?? { head: 'head-3', body: 'body-1', accessory: null, pet: null },
  )
  const [name, setName] = useState(did?.name ?? '')
  const [bio, setBio] = useState(did?.bio ?? '')
  const [chain, setChain] = useState<ChainType>('Polygon')
  const [phase, setPhase] = useState<MintPhase>('idle')

  const nameTaken = name.trim().length > 0 && takenNames.includes(name.trim().toLowerCase())
  const nameOk = name.trim().length >= 2 && !nameTaken

  // 当前选中的素材及待支付 mint 费的素材(未持有)
  const selectedItems = useMemo(
    () => Object.values(equipped).map((id) => nftLibrary.find((i) => i.id === id)).filter((i): i is NonNullable<typeof i> => !!i),
    [equipped],
  )
  const unownedSelected = selectedItems.filter((i) => !i.owned)
  const mintFee = unownedSelected.reduce((s, i) => s + i.price, 0)
  const total = GAS_FEE + mintFee

  const pick = (id: string, category: NFTCategory) =>
    setEquipped((e) => ({ ...e, [category]: e[category] === id ? null : id }))

  const doMint = () => {
    if (!nameOk) return
    setPhase('signing')
    setTimeout(() => setPhase('onchain'), 1500)
    setTimeout(() => {
      setPhase('done')
      addToInventory(unownedSelected)
      mintDID(name.trim(), bio.trim(), chain, equipped)
    }, 3200)
    setTimeout(() => {
      showToast('🎉 DID 身份 NFT 已生成,配件已存入资产背包')
      nav('/profile')
    }, 4200)
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h2 className="text-2xl font-bold mb-1">NFT 铸造工坊</h2>
      <p className="text-sm text-slate-400 mb-6">挑选模块化 NFT 组件,自由搭配并铸造你的专属 DID 身份</p>

      <div className="grid lg:grid-cols-[280px_1fr_300px] gap-6">
        {/* 左栏:纸娃娃实时预览 */}
        <div className="glass p-5 flex flex-col items-center">
          <div className="text-sm text-slate-400 mb-3 self-start">实时预览</div>
          <PaperDoll equipped={equipped} size="lg" interactive />
          <div className="w-full mt-5 pt-4 border-t border-white/10 space-y-2 text-sm">
            <div className="flex justify-between text-slate-400">
              <span>预估 Gas</span><span className="font-mono text-neon-cyan">{GAS_FEE} ETH</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>已选组件</span><span>{selectedItems.length} 件</span>
            </div>
            <button className="btn-primary w-full mt-2" disabled={phase !== 'idle'} onClick={doMint}>
              铸造专属 DID 身份 NFT
            </button>
          </div>
        </div>

        {/* 中栏:模块化组件库 */}
        <div className="glass p-5">
          <div className="flex gap-2 mb-1 flex-wrap">
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
          <p className="text-xs text-slate-500 mb-4">{tabs.find((t) => t.key === tab)?.desc}(均为独立 NFT)</p>
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {nftLibrary
              .filter((i) => i.category === tab)
              .map((i) => (
                <NFTCard key={i.id} item={i} selected={equipped[tab] === i.id} onClick={() => pick(i.id, tab)} />
              ))}
          </div>
          <p className="text-xs text-slate-500 mt-4">💡 点击素材实时换装;未持有素材将计入铸造 mint 费,铸造后存入资产背包</p>
        </div>

        {/* 右栏:铸造参数 */}
        <div className="glass p-5 space-y-4 h-fit">
          <div>
            <label className="text-xs text-slate-400">DID 身份名称(链上永久,不可重复)</label>
            <input className="input mt-1" placeholder="输入 2 个字符以上" value={name} onChange={(e) => setName(e.target.value)} />
            {nameTaken && <p className="text-xs text-rose-400 mt-1">✕ 该名称已被占用</p>}
            {nameOk && <p className="text-xs text-emerald-400 mt-1">✓ 名称可用</p>}
          </div>
          <div>
            <label className="text-xs text-slate-400">身份简介(同步到个人主页)</label>
            <textarea className="input mt-1 h-20 resize-none" placeholder="介绍一下你的链上身份…" value={bio} onChange={(e) => setBio(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-slate-400">选择公链</label>
            <div className="flex gap-2 mt-1">
              {chains.map((c) => (
                <button
                  key={c}
                  onClick={() => setChain(c)}
                  className={`flex-1 px-2 py-2 rounded-xl text-xs transition ${chain === c ? 'bg-neon-grad text-white' : 'glass text-slate-300'}`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400">铸造数量</label>
            <div className="input mt-1 text-slate-500 text-xs">1 份专属 DID 主 NFT(配件为多份可交易 NFT)</div>
          </div>
          {/* 费用明细 */}
          <div className="border-t border-white/10 pt-3 space-y-1.5 text-sm">
            <div className="flex justify-between text-slate-400 text-xs"><span>铸造 Gas 费</span><span className="font-mono">{GAS_FEE} ETH</span></div>
            <div className="flex justify-between text-slate-400 text-xs">
              <span>素材 mint 费({unownedSelected.length} 件未持有)</span>
              <span className="font-mono">{mintFee.toFixed(4)} ETH</span>
            </div>
            <div className="flex justify-between font-semibold pt-1"><span>合计</span><span className="font-mono text-neon-cyan">{total.toFixed(4)} ETH</span></div>
          </div>
          <button className="btn-primary w-full" disabled={!nameOk || phase !== 'idle'} onClick={doMint}>
            确认铸造
          </button>
        </div>
      </div>

      {/* 链上交易进度弹窗 */}
      {phase !== 'idle' && (
        <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm grid place-items-center p-4">
          <div className="glass neon-border w-full max-w-sm p-8 text-center">
            {phase !== 'done' ? (
              <>
                <div className="w-14 h-14 mx-auto rounded-full border-2 border-neon-purple border-t-transparent animate-spin" />
                <p className="mt-4 font-medium">{phase === 'signing' ? '等待钱包签名…' : '交易上链中…'}</p>
                <p className="text-xs text-slate-500 mt-1 font-mono">tx: 0x{Math.random().toString(16).slice(2, 18)}…</p>
              </>
            ) : (
              <>
                <div className="text-5xl">🎉</div>
                <p className="mt-3 font-semibold">DID 身份 NFT 已生成</p>
                <p className="text-xs text-slate-400 mt-1">正在跳转个人主页…</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
