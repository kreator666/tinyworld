import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ChainType, NFTCategory, Rarity } from '../types'
import { useAppStore } from '../store/appStore'
import { useChainStore } from '../store/chainStore'
import { nftLibrary } from '../mock/data'
import NFTCard, { rarityDot, rarityStyle } from '../components/NFTCard'
import PaperDoll from '../components/PaperDoll'
import { chainParts, partByChainId, SLOT_TO_CATEGORY } from '../lib/contracts'
import { isWalletOnActiveChain, fetchStarterClaimState, claimStarterPack, fetchMarketPrice, buyPartFromMarket, explainChainError } from '../lib/chainDispatch'
import { formatUnits } from 'viem'
import { explorerAddress, explorerTx, useChainConfig } from '../store/chainConfigStore'
import { getCharacterDisplay, getPartByChainId } from '../data/equipmentCatalog'
import { useI18n } from '../i18n'

const tabs: { key: NFTCategory | 'did'; labelKey: string }[] = [
  { key: 'did', labelKey: 'backpack.tab.did' },
  { key: 'head', labelKey: 'backpack.tab.head' },
  { key: 'body', labelKey: 'backpack.tab.body' },
  { key: 'accessory', labelKey: 'backpack.tab.accessory' },
  { key: 'pet', labelKey: 'backpack.tab.pet' },
]

const SLOT_MAP = { head: 0, body: 1, accessory: 2, pet: 3 }

// 资产背包:数据来源为链上合约(当前目标链)
export default function BackpackPage() {
  const { t } = useI18n()
  const active = useChainConfig((s) => s.active)
  const { connected, address, login } = useAppStore()
  const { tokenId, didName, equipped, parts, loading, error, refresh, equip, unequip, isAdmin, checkAdmin, mintParts, clear } = useChainStore()
  const [tab, setTab] = useState<NFTCategory | 'did'>('did')
  const [acting, setActing] = useState<string | null>(null)
  const [lastTx, setLastTx] = useState<string | null>(null)
  // 新手大礼包:EVM 需已配置 partsClaim 合约;NEAR 为身份合约内置 claim(2026-11 已支持);
  // 共同条件:钱包在目标链 + 已持有 DID + 未领取
  const [claimed, setClaimed] = useState<boolean | null>(null)
  const [claiming, setClaiming] = useState(false)
  const showToast = useAppStore((s) => s.showToast)
  const onTargetChain = isWalletOnActiveChain(login, active)
  const family = active.family ?? 'evm'
  const claimReady =
    (family === 'near' || (family === 'evm' && !!active.partsClaim)) && connected && onTargetChain && !!address && tokenId > 0

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

  // 读取新手大礼包领取状态(claimed)
  useEffect(() => {
    setClaimed(null)
    if (!claimReady || !address) return
    let cancelled = false
    fetchStarterClaimState(address)
      .then((s) => {
        if (!cancelled) setClaimed(s)
      })
      .catch(() => {
        if (!cancelled) setClaimed(null)
      })
    return () => {
      cancelled = true
    }
  }, [claimReady, address, active.key])

  // 领取新手大礼包:随机 4 件套 + 自动穿戴;缺失授权自动补齐(最多 3 笔签名)
  const doClaim = async () => {
    if (!address || !tokenId) return
    setClaiming(true)
    try {
      const hash = await claimStarterPack(address, tokenId)
      setLastTx(hash)
      setClaimed(true)
      showToast(t('backpack.claim.opened'))
      await refresh(address)
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
      showToast(t('backpack.equip.done', { name: part.name }))
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('backpack.equip.fail'))
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
      showToast(t('backpack.equip.unequipDone'))
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('backpack.equip.unequipFail'))
    } finally {
      setActing(null)
    }
  }

  // 市场直售价目表:链配置了 market 时一次性读全部装备的上架价(multicall 批读);未上架的不进表
  const [marketPrices, setMarketPrices] = useState<Record<number, bigint>>({})
  useEffect(() => {
    setMarketPrices({})
    if ((active.family ?? 'evm') !== 'evm' || !active.market || !connected || !onTargetChain) return
    let cancelled = false
    Promise.all(chainParts.map(async (p) => [p.id, await fetchMarketPrice(p.id)] as const))
      .then((entries) => {
        if (cancelled) return
        const m: Record<number, bigint> = {}
        for (const [id, price] of entries) if (price !== null) m[id] = price
        setMarketPrices(m)
      })
      .catch(() => {
        /* 价格读取失败按未上架处理,不阻塞页面 */
      })
    return () => {
      cancelled = true
    }
  }, [active.key, active.market, connected, onTargetChain])

  // 购买:优先走市场直售(链上 listPriceOf 为准,精确等值支付);
  // 未上架时管理员保留原铸造发行入口;普通用户提示市场未部署
  const doBuy = async (chainId: number, name: string) => {
    if (!address) return
    const price = marketPrices[chainId]
    if (price !== undefined) {
      setActing(`buy-${chainId}`)
      try {
        const hash = await buyPartFromMarket(address, chainId, 1, price)
        setLastTx(hash)
        showToast(t('backpack.buy.done', { name }))
        await refresh(address)
      } catch (err) {
        showToast(explainChainError(err))
      } finally {
        setActing(null)
      }
      return
    }
    if (!isAdmin) {
      showToast(t('backpack.buy.notListed', { name }))
      return
    }
    setActing(`buy-${chainId}`)
    try {
      const hash = await mintParts(address, address, [BigInt(chainId)], [1n])
      setLastTx(hash)
      showToast(t('backpack.buy.minted', { name }))
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('backpack.buy.mintFail'))
    } finally {
      setActing(null)
    }
  }

  const isWorn = (localId: string) => {
    const cat = tabs.find((t) => t.key !== 'did' && equipped[t.key as NFTCategory] === localId)?.key
    return !!cat
  }

  // 新手大礼包卡片:单按钮一键领取,随机 4 件套自动穿戴;4 个槽位展示神秘礼盒
  const renderStarterClaim = () => {
    if (!claimReady || claimed !== false) return null
    const slots: { labelKey: string; emoji: string }[] = [
      { labelKey: 'backpack.tab.head', emoji: '🎁' },
      { labelKey: 'backpack.tab.body', emoji: '🎁' },
      { labelKey: 'backpack.tab.accessory', emoji: '🎁' },
      { labelKey: 'backpack.tab.pet', emoji: '🎁' },
    ]
    return (
      <div className="glass neon-border p-5 mb-6">
        <div className="flex items-center gap-3">
          <span className="w-11 h-11 rounded-xl bg-neon-grad grid place-items-center text-2xl shadow-neon-purple">🎁</span>
          <div>
            <div className="font-semibold">{t('backpack.claim.title')}</div>
            <div className="text-xs text-slate-400 mt-0.5">
              {t('backpack.claim.desc')}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          {slots.map((s) => (
            <div key={s.labelKey} className="rounded-xl border border-white/10 p-3 text-center">
              <div className="w-full h-20 grid place-items-center text-3xl rounded-lg bg-slate-900/60">{s.emoji}</div>
              <div className="mt-2 text-sm text-slate-300">{t(s.labelKey)}</div>
              <div className="mt-1 text-[11px] text-slate-500">{t('backpack.claim.randomOne')}</div>
            </div>
          ))}
        </div>
        <button className="btn-primary w-full mt-4" disabled={claiming} onClick={doClaim}>
          {claiming ? t('backpack.claim.claiming') : t('backpack.claim.button')}
        </button>
        <div className="mt-2 text-[11px] text-slate-500 text-center">{t('backpack.claim.hint')}</div>
      </div>
    )
  }

  const renderList = () => {
    if (!connected || !onTargetChain) {
      return (
        <div className="glass p-10 text-center text-slate-500 max-w-md">
          {connected ? t('backpack.switchNetwork', { name: active.name }) : t('backpack.connectFirst')}
          <br />
          <Link to="/mint" className="btn-primary inline-block mt-4 text-sm">{t('backpack.goMint')}</Link>
        </div>
      )
    }

    if (loading && parts.length === 0) return <div className="glass p-10 text-center text-slate-500 max-w-md">{t('backpack.loading')}</div>
    if (error) return <div className="glass p-10 text-center text-rose-400 max-w-md">{t('backpack.readFail', { msg: error })}</div>

    if (tab === 'did') {
      if (tokenId === 0) {
        return (
          <div className="glass p-10 text-center text-slate-500 max-w-md">
            {t('backpack.noIdentity')}
            <br />
            <Link to="/mint" className="btn-primary inline-block mt-4 text-sm">{t('backpack.goMintShort')}</Link>
          </div>
        )
      }
      return (
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="glass neon-border p-5 max-w-md">
            <div className="flex items-center gap-4">
              <span className="w-14 h-14 rounded-xl bg-neon-grad grid place-items-center text-2xl shadow-neon-purple">🪪</span>
              <div>
                <div className="font-semibold">{t('backpack.didTitle', { name: didName })}</div>
                <div className="text-xs text-slate-500 font-mono mt-0.5">tokenId: {tokenId}</div>
              </div>
            </div>
            <div className="mt-4 space-y-1.5 text-xs text-slate-400 font-mono">
              <div>chain: {active.name}</div>
              <div>contract: <a className="text-neon-cyan hover:underline" href={explorerAddress(active.identity)} target="_blank" rel="noreferrer">DIDIdentity</a></div>
              <div>owner: {address}</div>
              <div>{t('backpack.countLabel')}</div>
            </div>
            {lastTx && (
              <div className="mt-3 text-[10px] text-slate-500">
                {t('backpack.lastTx')}<a className="text-neon-cyan hover:underline" href={explorerTx(lastTx)} target="_blank" rel="noreferrer">{lastTx.slice(0, 14)}…</a>
              </div>
            )}
          </div>
          <div className="glass p-5 flex flex-col items-center">
            <div className="text-sm text-slate-400 mb-2">{t('backpack.currentEquip')}</div>
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
    if (list.length === 0) return <div className="glass p-10 text-center text-slate-500 max-w-md">{t('backpack.emptyCategory')}</div>

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
              <div className="mt-2 text-[11px] text-slate-500 font-mono truncate">{t('backpack.chainId', { id: p.id })}</div>
              <div className="mt-2 flex gap-2">
                {worn ? (
                  <button
                    className="flex-1 !text-xs !py-1.5 rounded-xl bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 transition hover:bg-emerald-500/30"
                    disabled={acting === tab}
                    onClick={() => doUnequip(tab as NFTCategory)}
                  >
                    {acting === tab ? t('backpack.txPending') : t('backpack.wornBtn')}
                  </button>
                ) : p.balance > 0 ? (
                  <button
                    className="flex-1 btn-primary !text-xs !py-1.5"
                    disabled={acting === p.localId || tokenId === 0}
                    title={tokenId === 0 ? t('backpack.needMint') : undefined}
                    onClick={() => doEquip(p.localId, tab as NFTCategory)}
                  >
                    {acting === p.localId ? t('backpack.txPending') : t('backpack.equipBtn')}
                  </button>
                ) : (
                  <button
                    className="flex-1 btn-primary !text-xs !py-1.5"
                    disabled={acting === `buy-${p.id}`}
                    title={
                      marketPrices[p.id] !== undefined
                        ? t('backpack.buyMarketTitle')
                        : isAdmin
                          ? t('backpack.mintTitle')
                          : t('backpack.notListedTitle')
                    }
                    onClick={() => doBuy(p.id, p.name)}
                  >
                    {acting === `buy-${p.id}`
                      ? t('backpack.buying')
                      : marketPrices[p.id] !== undefined
                        ? t('backpack.buyPrice', {
                            price: formatUnits(marketPrices[p.id], active.chain.nativeCurrency.decimals),
                            symbol: active.chain.nativeCurrency.symbol,
                          })
                        : t('backpack.buyBtn')}
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
      <h2 className="text-2xl font-bold mb-1">{t('backpack.title')}</h2>
      <p className="text-sm text-slate-400 mb-5">{t('backpack.subtitle', { name: active.name })}</p>

      {renderStarterClaim()}

      <div className="flex gap-2 mb-6 flex-wrap">
        {tabs.map((tb) => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            className={`px-4 py-2 rounded-xl text-sm transition ${
              tab === tb.key ? 'bg-neon-grad text-white shadow-neon-purple' : 'glass text-slate-300 hover:border-neon-purple/50'
            }`}
          >
            {t(tb.labelKey)}
          </button>
        ))}
      </div>

      {renderList()}
    </div>
  )
}
