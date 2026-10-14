import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ChainType, NFTCategory, Rarity } from '../types'
import { useAppStore } from '../store/appStore'
import { useChainStore } from '../store/chainStore'
import { nftLibrary } from '../mock/data'
import NFTCard, { rarityDot, rarityStyle } from '../components/NFTCard'
import PaperDoll from '../components/PaperDoll'
import { chainParts, partByChainId, SLOT_TO_CATEGORY } from '../lib/contracts'
import { isWalletOnActiveChain, fetchStarterClaimState, claimStarterPart, explainChainError } from '../lib/chainDispatch'
import { explorerAddress, explorerTx, useChainConfig } from '../store/chainConfigStore'
import { getCharacterDisplay, getPartByChainId } from '../data/equipmentCatalog'

const tabs: { key: NFTCategory | 'did'; label: string }[] = [
  { key: 'did', label: 'Agent 主身份' },
  { key: 'head', label: '头部' },
  { key: 'body', label: '身体' },
  { key: 'accessory', label: '配饰' },
  { key: 'pet', label: '宠物' },
]

const SLOT_MAP = { head: 0, body: 1, accessory: 2, pet: 3 }

// 资产背包:数据来源为链上合约(当前目标链)
export default function BackpackPage() {
  const active = useChainConfig((s) => s.active)
  const { connected, address, login } = useAppStore()
  const { tokenId, didName, equipped, parts, loading, error, refresh, equip, unequip, isAdmin, checkAdmin, mintParts, clear } = useChainStore()
  const [tab, setTab] = useState<(typeof tabs)[number]['key']>('did')
  const [acting, setActing] = useState<string | null>(null)
  const [lastTx, setLastTx] = useState<string | null>(null)
  // 新手装备免费领养:需 evm 链 + 已配置 partsClaim + 钱包在目标链 + 已持有 DID + 未领取
  const [claimState, setClaimState] = useState<{ claimed: boolean; pool: number[] } | null>(null)
  const [claimPick, setClaimPick] = useState<number | null>(null)
  const [claiming, setClaiming] = useState(false)
  const showToast = useAppStore((s) => s.showToast)
  const onTargetChain = isWalletOnActiveChain(login, active)
  const claimReady =
    (active.family ?? 'evm') === 'evm' && !!active.partsClaim && connected && onTargetChain && !!address && tokenId > 0

  // 切链先清空旧链的 DID/装备数据,避免展示上一链的背包内容
  useEffect(() => {
    clear()
  }, [active.key, clear])

  useEffect(() => {
    if (connected && onTargetChain && address) {
      refresh(address)
      checkAdmin(address)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, onTargetChain, address, active.key])

  // 读取新手装备领养状态(claimed + 池内 4 件装备 id)
  useEffect(() => {
    setClaimState(null)
    setClaimPick(null)
    if (!claimReady || !address) return
    let cancelled = false
    fetchStarterClaimState(address)
      .then((s) => {
        if (!cancelled) setClaimState(s)
      })
      .catch(() => {
        if (!cancelled) setClaimState(null)
      })
    return () => {
      cancelled = true
    }
  }, [claimReady, address, active.key])

  // 领取一件新手装备:钱包自签、自付 gas,上链确认后刷新链上背包
  const doClaim = async () => {
    if (!address || claimPick === null) return
    setClaiming(true)
    try {
      const hash = await claimStarterPart(address, claimPick)
      setLastTx(hash)
      setClaimState((s) => (s ? { ...s, claimed: true } : s))
      showToast(`已领取新手装备「${partByChainId(claimPick)?.name ?? claimPick}」,已切到对应分类,点「穿戴」即可上身`)
      await refresh(address)
      // 领取后自动切到该装备所在分类页签,避免用户不知道装备在哪
      const slot = partByChainId(claimPick)?.slot ?? 0
      const cat = SLOT_TO_CATEGORY[slot] as (typeof tabs)[number]['key'] | undefined
      if (cat) setTab(cat)
    } catch (err) {
      showToast(explainChainError(err))
    } finally {
      setClaiming(false)
    }
  }

  const doEquip = async (localId: string, category: NFTCategory) => {
    const part = chainParts.find((p) => p.localId === localId)
    const slot = SLOT_MAP[category]
    if (!part || !address || !tokenId) return
    setActing(localId)
    try {
      const hash = await equip(address, slot, part.id)
      setLastTx(hash)
      showToast(`已为 Agent 穿戴「${part.name}」`)
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
      const hash = await unequip(address, slot)
      setLastTx(hash)
      showToast('已卸下链上装备')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '链上卸下失败')
    } finally {
      setActing(null)
    }
  }

  // 购买 = 链上铸造 1 份到本人地址(测试网免费 Gas,仅管理员/铸造方可执行;
  // 普通用户暂无可用的售卖合约,点击给出提示,与铸造工坊行为一致)
  const doBuy = async (chainId: number, name: string) => {
    if (!address) return
    if (!isAdmin) {
      showToast(`「${name}」尚未持有，购买市场合约未部署`)
      return
    }
    setActing(`buy-${chainId}`)
    try {
      const hash = await mintParts(address, address, [BigInt(chainId)], [1n])
      setLastTx(hash)
      showToast(`已铸造「${name}」×1 到你的背包`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '链上铸造失败')
    } finally {
      setActing(null)
    }
  }

  const isWorn = (localId: string) => {
    const cat = tabs.find((t) => t.key !== 'did' && equipped[t.key as NFTCategory] === localId)?.key
    return !!cat
  }

  // 新手装备免费领养卡片:池内 4 件装备任选一件
  const renderStarterClaim = () => {
    if (!claimReady || !claimState || claimState.claimed || claimState.pool.length === 0) return null
    return (
      <div className="glass neon-border p-5 mb-6">
        <div className="flex items-center gap-3">
          <span className="w-11 h-11 rounded-xl bg-neon-grad grid place-items-center text-2xl shadow-neon-purple">🎁</span>
          <div>
            <div className="font-semibold">领取新手装备</div>
            <div className="text-xs text-slate-400 mt-0.5">
              新用户福利:从下方任选 1 件起步装备免费领养(每地址限一次,钱包自签并自付少量 Gas)
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          {claimState.pool.map((id) => {
            const part = partByChainId(id)
            const catalog = getPartByChainId(id)
            const category = SLOT_TO_CATEGORY[part?.slot ?? 0] as NFTCategory
            const display = getCharacterDisplay(category, part?.localId ?? '')
            const imageUrl = display?.imageUrl || catalog?.imageUrl
            const name = display?.name || part?.name || `装备 ${id}`
            const picked = claimPick === id
            return (
              <button
                key={id}
                onClick={() => setClaimPick(id)}
                className={`rounded-xl border p-3 text-left transition ${
                  picked ? 'border-neon-cyan bg-neon-cyan/10 shadow-neon-cyan' : 'border-white/10 hover:border-neon-purple/50'
                }`}
              >
                {imageUrl ? (
                  <img src={imageUrl} alt={name} className="w-full h-20 object-contain rounded-lg bg-slate-900/60" />
                ) : (
                  <div className="w-full h-20 grid place-items-center text-3xl rounded-lg bg-slate-900/60">{catalog?.emoji ?? '❓'}</div>
                )}
                <div className="mt-2 text-sm truncate">{name}</div>
                <div className="mt-1">
                  <span className={`tag ${rarityStyle[(part?.rarity ?? '普通') as Rarity]}`}>
                    {rarityDot[(part?.rarity ?? '普通') as Rarity]} {part?.rarity ?? '普通'}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
        <button className="btn-primary w-full mt-4" disabled={claiming || claimPick === null} onClick={doClaim}>
          {claiming ? '领取中…' : claimPick === null ? '先选择一件装备' : '免费领取所选装备'}
        </button>
      </div>
    )
  }

  const renderList = () => {
    if (!connected || !onTargetChain) {
      return (
        <div className="glass p-10 text-center text-slate-500 max-w-md">
          {connected ? `⚠️ 请切换到 ${active.name} 网络以查看链上资产` : '请先连接钱包以查看链上资产'}
          <br />
          <Link to="/mint" className="btn-primary inline-block mt-4 text-sm">去铸造 Agent</Link>
        </div>
      )
    }

    if (loading && parts.length === 0) return <div className="glass p-10 text-center text-slate-500 max-w-md">链上资产读取中…</div>
    if (error) return <div className="glass p-10 text-center text-rose-400 max-w-md">读取失败: {error}</div>

    if (tab === 'did') {
      if (tokenId === 0) {
        return (
          <div className="glass p-10 text-center text-slate-500 max-w-md">
            尚未铸造 Agent 主身份
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
              <div>chain: {active.name}</div>
              <div>contract: <a className="text-neon-cyan hover:underline" href={explorerAddress(active.identity)} target="_blank" rel="noreferrer">DIDIdentity</a></div>
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
          // head/body 与铸造工坊一致:展示 v4 角色库形象(角色 N + 头/身体切片)
          const display = getCharacterDisplay(tab as NFTCategory, p.localId)
          const item = p.local
            ? {
                ...p.local,
                name: display?.name ?? p.local.name,
                imageUrl: display?.imageUrl || p.local.imageUrl,
                owned: p.balance > 0,
                count: p.balance,
                chain: active.name,
              }
            : {
                id: p.localId,
                name: display?.name ?? p.name,
                imageUrl: display?.imageUrl || undefined,
                category: tab,
                rarity: p.rarity as Rarity,
                price: 0,
                emoji: '❓',
                gradient: 'from-slate-500 to-slate-700',
                owned: p.balance > 0,
                hash: '0x0',
                chain: active.name,
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
                    title={tokenId === 0 ? '请先铸造 Agent' : undefined}
                    onClick={() => doEquip(p.localId, tab as NFTCategory)}
                  >
                    {acting === p.localId ? '上链中…' : '穿戴'}
                  </button>
                ) : (
                  <button
                    className="flex-1 btn-primary !text-xs !py-1.5"
                    disabled={acting === `buy-${p.id}`}
                    title={isAdmin ? '铸造 1 份到当前钱包' : '购买市场合约未部署'}
                    onClick={() => doBuy(p.id, p.name)}
                  >
                    {acting === `buy-${p.id}` ? '铸造中…' : '购买'}
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
      <p className="text-sm text-slate-400 mb-5">链上资产(连接 {active.name} 后自动读取)</p>

      {renderStarterClaim()}

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
