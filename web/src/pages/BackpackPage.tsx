import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ChainType, NFTCategory, Rarity } from '../types'
import { useAppStore } from '../store/appStore'
import { useChainStore } from '../store/chainStore'
import { nftLibrary } from '../mock/data'
import NFTCard, { rarityDot, rarityStyle } from '../components/NFTCard'
import PaperDoll from '../components/PaperDoll'
import { chainParts, explorerAddress, explorerTx, TARGET_CHAIN_ID } from '../lib/contracts'

const tabs: { key: NFTCategory | 'did'; label: string }[] = [
  { key: 'did', label: 'DID 主身份' },
  { key: 'head', label: '头部藏品' },
  { key: 'body', label: '身体' },
  { key: 'accessory', label: '配饰' },
  { key: 'pet', label: '宠物' },
]

const SLOT_MAP = { head: 0, body: 1, accessory: 2, pet: 3 }

// 资产背包:数据来源为链上合约(Sepolia)
export default function BackpackPage() {
  const { connected, address, login } = useAppStore()
  const { tokenId, didName, equipped, parts, loading, error, refresh, equip, unequip } = useChainStore()
  const [tab, setTab] = useState<(typeof tabs)[number]['key']>('did')
  const [acting, setActing] = useState<string | null>(null)
  const [lastTx, setLastTx] = useState<string | null>(null)
  const showToast = useAppStore((s) => s.showToast)
  const isSepolia = login?.chainId === TARGET_CHAIN_ID

  useEffect(() => {
    if (connected && isSepolia && address) refresh(address as `0x${string}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, isSepolia, address])

  const doEquip = async (localId: string, category: NFTCategory) => {
    const part = chainParts.find((p) => p.localId === localId)
    const slot = SLOT_MAP[category]
    if (!part || !address || !tokenId) return
    setActing(localId)
    try {
      const hash = await equip(address as `0x${string}`, slot, part.id)
      setLastTx(hash)
      showToast(`已穿戴「${part.name}」到链上 DID`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '链上穿戴失败')
    } finally {
      setActing(null)
    }
  }

  const doUnequip = async (category: NFTCategory) => {
    const slot = SLOT_MAP[category]
    if (!address || !tokenId) return
    setActing(category)
    try {
      const hash = await unequip(address as `0x${string}`, slot)
      setLastTx(hash)
      showToast('已卸下链上装备')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '链上卸下失败')
    } finally {
      setActing(null)
    }
  }

  const isWorn = (localId: string) => {
    const cat = tabs.find((t) => t.key !== 'did' && equipped[t.key as NFTCategory] === localId)?.key
    return !!cat
  }

  const renderList = () => {
    if (!connected || !isSepolia) {
      return (
        <div className="glass p-10 text-center text-slate-500 max-w-md">
          {connected ? '⚠️ 请切换到 Sepolia 网络以查看链上资产' : '请先连接钱包以查看链上资产'}
          <br />
          <Link to="/mint" className="btn-primary inline-block mt-4 text-sm">去铸造 DID</Link>
        </div>
      )
    }

    if (loading && parts.length === 0) return <div className="glass p-10 text-center text-slate-500 max-w-md">链上资产读取中…</div>
    if (error) return <div className="glass p-10 text-center text-rose-400 max-w-md">读取失败: {error}</div>

    if (tab === 'did') {
      if (tokenId === 0) {
        return (
          <div className="glass p-10 text-center text-slate-500 max-w-md">
            尚未铸造 DID 主身份 NFT
            <br />
            <Link to="/mint" className="btn-primary inline-block mt-4 text-sm">去铸造</Link>
          </div>
        )
      }
      return (
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="glass neon-border p-5 max-w-md">
            <div className="flex items-center gap-4">
              <span className="w-14 h-14 rounded-xl bg-neon-grad grid place-items-center text-2xl shadow-neon-purple">🪪</span>
              <div>
                <div className="font-semibold">{didName} · 主身份 NFT</div>
                <div className="text-xs text-slate-500 font-mono mt-0.5">tokenId: {tokenId}</div>
              </div>
            </div>
            <div className="mt-4 space-y-1.5 text-xs text-slate-400 font-mono">
              <div>chain: Sepolia</div>
              <div>contract: <a className="text-neon-cyan hover:underline" href={explorerAddress('0x363AF72fC15af43BfEA47C1ED09128Cd994946c1')} target="_blank" rel="noreferrer">DIDIdentity</a></div>
              <div>owner: {address}</div>
              <div>数量: 1(专属)</div>
            </div>
            {lastTx && (
              <div className="mt-3 text-[10px] text-slate-500">
                最近交易: <a className="text-neon-cyan hover:underline" href={explorerTx(lastTx)} target="_blank" rel="noreferrer">{lastTx.slice(0, 14)}…</a>
              </div>
            )}
          </div>
          <div className="glass p-5 flex flex-col items-center">
            <div className="text-sm text-slate-400 mb-2">当前链上装备</div>
            <PaperDoll equipped={equipped} size="lg" />
          </div>
        </div>
      )
    }

    const categorySlot: Record<'did' | NFTCategory, number> = { did: -1, head: 0, body: 1, accessory: 2, pet: 3 }
    const list = parts
      .filter((p) => p.slot === categorySlot[tab])
      .map((p) => {
        const local = nftLibrary.find((i) => i.id === p.localId)
        return { ...p, local }
      })
    if (list.length === 0) return <div className="glass p-10 text-center text-slate-500 max-w-md">该分类下暂无链上配件</div>

    return (
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {list.map((p) => {
          const item = p.local
            ? { ...p.local, owned: p.balance > 0, count: p.balance, chain: 'Sepolia' as ChainType }
            : {
                id: p.localId,
                name: p.name,
                category: tab,
                rarity: p.rarity as Rarity,
                price: 0,
                emoji: '❓',
                gradient: 'from-slate-500 to-slate-700',
                owned: p.balance > 0,
                hash: '0x0',
                chain: 'Sepolia' as ChainType,
                count: p.balance,
              }
          const worn = equipped[tab as NFTCategory] === p.localId
          return (
            <div key={p.id} className="relative">
              <NFTCard item={item} />
              <div className="mt-2 text-[11px] text-slate-500 font-mono truncate">链上 id: {p.id}</div>
              <div className="mt-2 flex gap-2">
                {worn ? (
                  <button
                    className="flex-1 !text-xs !py-1.5 rounded-xl bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 transition hover:bg-emerald-500/30"
                    disabled={acting === tab}
                    onClick={() => doUnequip(tab as NFTCategory)}
                  >
                    {acting === tab ? '上链中…' : '✓ 穿戴中 · 卸下'}
                  </button>
                ) : p.balance > 0 ? (
                  <button
                    className="flex-1 btn-primary !text-xs !py-1.5"
                    disabled={acting === p.localId || tokenId === 0}
                    title={tokenId === 0 ? '请先铸造 DID 身份' : undefined}
                    onClick={() => doEquip(p.localId, tab as NFTCategory)}
                  >
                    {acting === p.localId ? '上链中…' : '穿戴'}
                  </button>
                ) : (
                  <button className="flex-1 btn-ghost !text-xs !py-1.5 opacity-60 cursor-not-allowed" disabled>
                    未持有
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h2 className="text-2xl font-bold mb-1">资产背包</h2>
      <p className="text-sm text-slate-400 mb-5">链上资产(连接 Sepolia 后自动读取)</p>

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

      {renderList()}
    </div>
  )
}
