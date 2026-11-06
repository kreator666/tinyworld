import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PublicKey } from '@solana/web3.js'
import { t, useI18n } from '../i18n'
import { isWalletOnActiveChain } from '../lib/chainDispatch'
import { isValidNearAddress } from '../lib/walletNear'
import type { NFTCategory, Rarity } from '../types'
import { useAppStore } from '../store/appStore'
import { useChainStore } from '../store/chainStore'
import {
  getCharacterDisplay,
  getPartsByCategory,
  getPartsByRarity,
  getRarityMintAmount,
} from '../data/equipmentCatalog'
import { explorerTx, useChainConfig } from '../store/chainConfigStore'
import { rarityDot, rarityStyle } from '../components/NFTCard'

const TABS: { key: NFTCategory; labelKey: string }[] = [
  { key: 'head', labelKey: 'head' },
  { key: 'body', labelKey: 'body' },
  { key: 'accessory', labelKey: 'accessory' },
  { key: 'pet', labelKey: 'pet' },
]

const RARITIES: Rarity[] = ['普通', '稀有', '史诗', '传说']

/** Rarity 数据值(链上/目录共用)到词典 key 的映射 */
const RARITY_KEYS: Record<Rarity, string> = {
  普通: 'common',
  稀有: 'rare',
  史诗: 'epic',
  传说: 'legend',
}

const rarityLabel = (r: Rarity) => t(`admin.rarity.${RARITY_KEYS[r]}`)

// 地址校验:EVM 0x / Solana base58 / NEAR account_id(按激活链族;格式都接受,铸造时以链上程序为准)
function isAddress(v: string, family: 'evm' | 'solana' | 'near' = 'evm'): boolean {
  if (family === 'near') return isValidNearAddress(v)
  if (/^0x[a-fA-F0-9]{40}$/.test(v)) return true
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) {
    try {
      new PublicKey(v)
      return true
    } catch {
      return false
    }
  }
  return false
}

export default function AdminPage() {
  const { t } = useI18n()
  const active = useChainConfig((s) => s.active)
  const { connected, address, login } = useAppStore()
  const { isAdmin, adminLoading, partStates, checkAdmin, refreshPartStates, registerParts, mintParts, error } = useChainStore()
  const showToast = useAppStore((s) => s.showToast)

  const [tab, setTab] = useState<NFTCategory>('head')
  const [checking, setChecking] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [mintAmounts, setMintAmounts] = useState<Record<Rarity, number>>({
    普通: getRarityMintAmount('普通'),
    稀有: getRarityMintAmount('稀有'),
    史诗: getRarityMintAmount('史诗'),
    传说: getRarityMintAmount('传说'),
  })
  const [regProgress, setRegProgress] = useState<{ current: number; total: number; name: string } | null>(null)
  const [mintProgress, setMintProgress] = useState<{ current: number; total: number; rarity: Rarity } | null>(null)
  const [lastTx, setLastTx] = useState<string | null>(null)

  const onTargetChain = isWalletOnActiveChain(login, active)

  useEffect(() => {
    if (!connected || !onTargetChain || !address) return
    setChecking(true)
    checkAdmin(address).then((ok) => {
      setChecking(false)
      if (ok) refreshPartStates()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, onTargetChain, address])

  const stateMap = useMemo(() => {
    const map = new Map(partStates.map((p) => [p.id, p]))
    return map
  }, [partStates])

  const tabParts = useMemo(() => getPartsByCategory(tab), [tab])

  const allRegistered = useMemo(() => tabParts.every((p) => stateMap.get(p.chainId)?.registered), [tabParts, stateMap])

  const doRegisterCategory = async () => {
    if (!address || !isAdmin) return
    const unregistered = tabParts.filter((p) => !stateMap.get(p.chainId)?.registered)
    if (unregistered.length === 0) {
      showToast(t('admin.register.allDone'))
      return
    }
    const parts = unregistered.map((p) => ({
      chainId: p.chainId,
      slot: p.slot,
      rarity: p.rarityChain,
      maxSupply: p.maxSupply,
      name: p.name,
    }))
    setRegProgress({ current: 0, total: parts.length, name: '' })
    setLastTx(null)
    try {
      await registerParts(
        address,
        parts,
        (p) => {
          const item = parts[p.current - 1]
          setRegProgress({ current: p.current, total: p.total, name: item?.name ?? '' })
          if (p.txHash) setLastTx(p.txHash)
        },
      )
      showToast(t('admin.register.done', { label: t(`admin.tab.${tab}`), count: parts.length }))
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('admin.register.fail'))
    } finally {
      setRegProgress(null)
    }
  }

  const doMintCategory = async () => {
    if (!address || !isAdmin) return
    const to = recipient.trim() || address
    if (!isAddress(to, active.family ?? 'evm')) {
      showToast(t('admin.mint.invalidAddress'))
      return
    }

    const batches = RARITIES.map((rarity) => ({
      rarity,
      items: getPartsByRarity(tab, rarity).filter((p) => {
        const state = stateMap.get(p.chainId)
        if (!state?.registered || !state.mintable) return false
        const amount = mintAmounts[rarity]
        return state.totalSupply + amount <= state.maxSupply
      }),
    })).filter((b) => b.items.length > 0 && mintAmounts[b.rarity] > 0)

    if (batches.length === 0) {
      showToast(t('admin.mint.noMintable'))
      return
    }

    setMintProgress({ current: 0, total: batches.length, rarity: '普通' })
    setLastTx(null)
    try {
      for (let i = 0; i < batches.length; i++) {
        const { rarity, items } = batches[i]
        const amount = mintAmounts[rarity]
        setMintProgress({ current: i + 1, total: batches.length, rarity })
        const ids = items.map((p) => BigInt(p.chainId))
        const amounts = items.map(() => BigInt(amount))
        const hash = await mintParts(address, to, ids, amounts)
        setLastTx(hash)
      }
      showToast(t('admin.mint.done', { addr: `${to.slice(0, 6)}…${to.slice(-4)}`, label: t(`admin.tab.${tab}`) }))
      await refreshPartStates()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('admin.mint.fail'))
    } finally {
      setMintProgress(null)
    }
  }

  if (!connected) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <div className="glass p-10 text-center text-slate-400 max-w-md mx-auto">
          {t('admin.connectFirst')}
          <br />
          <Link to="/" className="btn-primary inline-block mt-4 text-sm">{t('admin.backHome')}</Link>
        </div>
      </div>
    )
  }

  if (!onTargetChain) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <div className="glass p-10 text-center text-amber-400 max-w-md mx-auto">
          {t('admin.wrongNetwork', { name: active.name })}
        </div>
      </div>
    )
  }

  if (checking) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <div className="glass p-10 text-center text-slate-400 max-w-md mx-auto">{t('admin.checking')}</div>
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <div className="glass border border-rose-500/40 p-10 text-center max-w-md mx-auto">
          <p className="text-rose-400 font-semibold">{t('admin.noPermission')}</p>
          <p className="text-sm text-slate-400 mt-2">
            {t('admin.noPermissionDetail')}
          </p>
          <p className="text-xs font-mono text-slate-500 mt-4 break-all">{address}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold">{t('admin.title')}</h2>
          <p className="text-sm text-slate-400 mt-1">
            {t('admin.intro', { name: active.name })}
            <span className="font-mono text-neon-cyan">{address?.slice(0, 6)}…{address?.slice(-4)}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/admin/arena" className="btn-ghost text-xs">{t('admin.toArena')}</Link>
          <button
            className="btn-ghost text-xs"
            onClick={() => address && refreshPartStates()}
            disabled={adminLoading}
          >
            {adminLoading ? t('admin.refreshing') : t('admin.refresh')}
          </button>
          {lastTx && (
            <a
              className="btn-ghost text-xs"
              href={explorerTx(lastTx)}
              target="_blank"
              rel="noreferrer"
            >
              {t('admin.lastTx')}
            </a>
          )}
        </div>
      </div>

      {error && (
        <div className="glass border border-rose-500/40 p-4 mb-6 text-sm text-rose-400">
          {t('admin.chainError', { msg: error })}
        </div>
      )}

      {/* 类别标签 */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {TABS.map((x) => (
          <button
            key={x.key}
            onClick={() => setTab(x.key)}
            className={`px-4 py-2 rounded-xl text-sm transition ${
              tab === x.key ? 'bg-neon-grad text-white shadow-neon-purple' : 'glass text-slate-300 hover:border-neon-purple/50'
            }`}
          >
            {t(`admin.tab.${x.key}`)}
          </button>
        ))}
      </div>

      {/* 操作面板 */}
      <div className="grid lg:grid-cols-[1fr_320px] gap-6 mb-8">
        {/* 左侧：装备列表 */}
        <div className="glass p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">
              {t('admin.catalogTitle', { label: t(`admin.tab.${tab}`) })}
              <span className="text-slate-400 text-xs font-normal ml-2">{t('admin.countTotal', { count: tabParts.length })}</span>
            </h3>
            <span className={`text-xs ${allRegistered ? 'text-emerald-400' : 'text-amber-400'}`}>
              {allRegistered ? t('admin.allRegistered') : t('admin.someUnregistered')}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3 max-h-[520px] overflow-y-auto pr-2">
            {tabParts.map((p) => {
              const state = stateMap.get(p.chainId)
              // head/body 与铸造工坊一致:展示 v4 角色库形象(角色 N + 头/身体切片)
              const display = getCharacterDisplay(tab, p.localId)
              const displayName = display?.name ?? p.name
              const displayImage = display?.imageUrl || p.imageUrl
              return (
                <div
                  key={p.localId}
                  className={`glass p-3 relative ${state?.registered ? 'border-white/10' : 'border-amber-500/30'}`}
                >
                  <div className={`w-full h-20 rounded-xl bg-gradient-to-br ${p.gradient} grid place-items-center mb-2 overflow-hidden`}>
                    {displayImage ? (
                      <img
                        src={displayImage}
                        alt={displayName}
                        className="max-w-full max-h-full object-contain"
                        onError={(e) => {
                          const el = e.target as HTMLImageElement
                          el.style.display = 'none'
                          const parent = el.parentElement
                          if (parent) {
                            const span = document.createElement('span')
                            span.className = 'text-3xl'
                            span.textContent = p.emoji
                            parent.appendChild(span)
                          }
                        }}
                      />
                    ) : (
                      <span className="text-3xl">{p.emoji}</span>
                    )}
                  </div>
                  <div className="text-xs font-medium truncate" title={displayName}>{displayName}</div>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className={`tag ${rarityStyle[p.rarity]} text-[10px]`}>
                      {rarityDot[p.rarity]} {rarityLabel(p.rarity)}
                    </span>
                    <span className="text-[10px] text-slate-500 font-mono">#{p.chainId}</span>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-400 leading-relaxed">
                    {state ? (
                      <>
                        <div className={state.registered ? 'text-emerald-400' : 'text-amber-400'}>
                          {state.registered ? t('admin.stateRegistered') : t('admin.stateUnregistered')}
                        </div>
                        <div>{t('admin.maxMinted', { max: state.maxSupply.toLocaleString(), minted: state.totalSupply.toLocaleString() })}</div>
                        <div className={state.mintable ? 'text-slate-400' : 'text-rose-400'}>
                          {state.mintable ? t('admin.mintable') : t('admin.closed')}
                        </div>
                      </>
                    ) : (
                      <div className="text-slate-500">{t('admin.reading')}</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* 右侧：发行操作 */}
        <div className="space-y-4">
          <div className="glass p-5">
            <h3 className="font-semibold mb-3">{t('admin.register.step')}</h3>
            <p className="text-xs text-slate-400 mb-4">
              {t('admin.register.desc', { count: 30, label: t(`admin.tab.${tab}`) })}
            </p>
            {regProgress ? (
              <div className="space-y-2">
                <div className="text-sm text-neon-cyan">
                  {t('admin.register.progress', { current: regProgress.current, total: regProgress.total, name: regProgress.name })}
                </div>
                <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-neon-grad transition-all"
                    style={{ width: `${(regProgress.current / regProgress.total) * 100}%` }}
                  />
                </div>
              </div>
            ) : (
              <button
                className="btn-primary w-full"
                onClick={doRegisterCategory}
                disabled={regProgress !== null || adminLoading}
              >
                {t('admin.register.btn', { label: t(`admin.tab.${tab}`), count: 30 })}
              </button>
            )}
          </div>

          <div className="glass p-5">
            <h3 className="font-semibold mb-3">{t('admin.mint.step')}</h3>
            <p className="text-xs text-slate-400 mb-4">
              {t('admin.mint.descBefore')}<b>{t('admin.mint.descB1')}</b>{t('admin.mint.descMid1')}<b>{t('admin.mint.descB2')}</b>{t('admin.mint.descMid2')}<b>{t('admin.mint.descB3')}</b>{t('admin.mint.descAfter')}
            </p>
            <div className="mb-4">
              <label className="text-xs text-slate-400">{t('admin.mint.recipient')}</label>
              <input
                className="input mt-1"
                placeholder={t('admin.mint.recipientPlaceholder')}
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
              {!recipient.trim() && (
                <p className="text-[10px] text-slate-500 mt-1">{t('admin.mint.recipientHint')}</p>
              )}
            </div>

            <div className="space-y-3 mb-4">
              {RARITIES.map((rarity) => (
                <div key={rarity} className="flex items-center justify-between">
                  <span className={`text-xs ${rarityStyle[rarity]}`}>{rarityDot[rarity]} {rarityLabel(rarity)}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500">{t('admin.mint.perItem')}</span>
                    <input
                      type="number"
                      min={0}
                      className="input w-20 !py-1 text-xs"
                      value={mintAmounts[rarity]}
                      onChange={(e) =>
                        setMintAmounts((prev) => ({
                          ...prev,
                          [rarity]: Math.max(0, Number.parseInt(e.target.value || '0', 10)),
                        }))
                      }
                    />
                    <span className="text-[10px] text-slate-500">{t('admin.mint.copies')}</span>
                  </div>
                </div>
              ))}
            </div>

            {mintProgress ? (
              <div className="space-y-2">
                <div className="text-sm text-neon-cyan">
                  {t('admin.mint.progress', { current: mintProgress.current, total: mintProgress.total, rarity: rarityLabel(mintProgress.rarity) })}
                </div>
                <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-neon-grad transition-all"
                    style={{ width: `${(mintProgress.current / mintProgress.total) * 100}%` }}
                  />
                </div>
              </div>
            ) : (
              <button
                className="btn-primary w-full"
                onClick={doMintCategory}
                disabled={mintProgress !== null || adminLoading}
              >
                {t('admin.mint.btn', { label: t(`admin.tab.${tab}`) })}
              </button>
            )}

            <p className="text-[10px] text-slate-500 mt-3 leading-relaxed">
              {t('admin.mint.note')}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
