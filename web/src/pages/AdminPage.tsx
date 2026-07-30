import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Address, Hash } from 'viem'
import type { NFTCategory, Rarity } from '../types'
import { useAppStore } from '../store/appStore'
import { useChainStore } from '../store/chainStore'
import {
  getPartsByCategory,
  getPartsByRarity,
  getRarityMintAmount,
} from '../data/equipmentCatalog'
import { TARGET_CHAIN_ID } from '../lib/contracts'
import { explorerTx } from '../lib/contracts'
import { rarityDot, rarityStyle } from '../components/NFTCard'

const TABS: { key: NFTCategory; label: string }[] = [
  { key: 'head', label: '头部' },
  { key: 'body', label: '身体' },
  { key: 'accessory', label: '配饰' },
  { key: 'pet', label: '宠物' },
]

const RARITIES: Rarity[] = ['普通', '稀有', '史诗', '传说']

function isAddress(v: string): v is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(v)
}

export default function AdminPage() {
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
  const [lastTx, setLastTx] = useState<Hash | null>(null)

  const isSepolia = login?.chainId === TARGET_CHAIN_ID

  useEffect(() => {
    if (!connected || !isSepolia || !address) return
    setChecking(true)
    checkAdmin(address as `0x${string}`).then((ok) => {
      setChecking(false)
      if (ok) refreshPartStates()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, isSepolia, address])

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
      showToast('本类所有装备都已注册，无需重复操作')
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
        address as `0x${string}`,
        parts,
        (p) => {
          const item = parts[p.current - 1]
          setRegProgress({ current: p.current, total: p.total, name: item?.name ?? '' })
          if (p.txHash) setLastTx(p.txHash)
        },
      )
      showToast(`✅ ${TABS.find((t) => t.key === tab)?.label} ${parts.length} 件未注册装备已上链`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '注册失败')
    } finally {
      setRegProgress(null)
    }
  }

  const doMintCategory = async () => {
    if (!address || !isAdmin) return
    const to = recipient.trim() || address
    if (!isAddress(to)) {
      showToast('请输入有效的 0x 地址')
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
      showToast('没有可铸造的装备（请检查是否已注册或 maxSupply 是否已满）')
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
        const hash = await mintParts(address as `0x${string}`, to as `0x${string}`, ids, amounts)
        setLastTx(hash)
      }
      showToast(`✅ 已向 ${to.slice(0, 6)}…${to.slice(-4)} 铸造 ${tab} 配件`)
      await refreshPartStates()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '铸造失败')
    } finally {
      setMintProgress(null)
    }
  }

  if (!connected) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <div className="glass p-10 text-center text-slate-400 max-w-md mx-auto">
          请先连接钱包以进入管理员页面
          <br />
          <Link to="/" className="btn-primary inline-block mt-4 text-sm">返回首页</Link>
        </div>
      </div>
    )
  }

  if (!isSepolia) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <div className="glass p-10 text-center text-amber-400 max-w-md mx-auto">
          管理员页面需切换到 Sepolia 测试网
        </div>
      </div>
    )
  }

  if (checking) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <div className="glass p-10 text-center text-slate-400 max-w-md mx-auto">正在校验管理员权限…</div>
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <div className="glass border border-rose-500/40 p-10 text-center max-w-md mx-auto">
          <p className="text-rose-400 font-semibold">⚠ 当前地址没有管理员权限</p>
          <p className="text-sm text-slate-400 mt-2">
            只有 DIDParts 合约 owner 或被授权的 minter 才能发行装备。
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
          <h2 className="text-2xl font-bold">装备发行后台</h2>
          <p className="text-sm text-slate-400 mt-1">
            在 Sepolia 上注册并铸造 ERC-1155 配件；当前地址：
            <span className="font-mono text-neon-cyan">{address?.slice(0, 6)}…{address?.slice(-4)}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-ghost text-xs"
            onClick={() => address && refreshPartStates()}
            disabled={adminLoading}
          >
            {adminLoading ? '刷新中…' : '刷新链上状态'}
          </button>
          {lastTx && (
            <a
              className="btn-ghost text-xs"
              href={explorerTx(lastTx)}
              target="_blank"
              rel="noreferrer"
            >
              最近交易
            </a>
          )}
        </div>
      </div>

      {error && (
        <div className="glass border border-rose-500/40 p-4 mb-6 text-sm text-rose-400">
          链上错误: {error}
        </div>
      )}

      {/* 类别标签 */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {TABS.map((t) => (
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

      {/* 操作面板 */}
      <div className="grid lg:grid-cols-[1fr_320px] gap-6 mb-8">
        {/* 左侧：装备列表 */}
        <div className="glass p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">
              {TABS.find((t) => t.key === tab)?.label}装备目录
              <span className="text-slate-400 text-xs font-normal ml-2">共 {tabParts.length} 件</span>
            </h3>
            <span className={`text-xs ${allRegistered ? 'text-emerald-400' : 'text-amber-400'}`}>
              {allRegistered ? '✓ 本类已全部注册' : '⚠ 尚有未注册装备'}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3 max-h-[520px] overflow-y-auto pr-2">
            {tabParts.map((p) => {
              const state = stateMap.get(p.chainId)
              return (
                <div
                  key={p.localId}
                  className={`glass p-3 relative ${state?.registered ? 'border-white/10' : 'border-amber-500/30'}`}
                >
                  <div className={`w-full h-20 rounded-xl bg-gradient-to-br ${p.gradient} grid place-items-center text-3xl mb-2`}>
                    {p.emoji}
                  </div>
                  <div className="text-xs font-medium truncate" title={p.name}>{p.name}</div>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className={`tag ${rarityStyle[p.rarity]} text-[10px]`}>
                      {rarityDot[p.rarity]} {p.rarity}
                    </span>
                    <span className="text-[10px] text-slate-500 font-mono">#{p.chainId}</span>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-400 leading-relaxed">
                    {state ? (
                      <>
                        <div className={state.registered ? 'text-emerald-400' : 'text-amber-400'}>
                          {state.registered ? '✓ 已注册' : '未注册'}
                        </div>
                        <div>max: {state.maxSupply.toLocaleString()} / 已铸: {state.totalSupply.toLocaleString()}</div>
                        <div className={state.mintable ? 'text-slate-400' : 'text-rose-400'}>
                          {state.mintable ? '可铸造' : '已关闭'}
                        </div>
                      </>
                    ) : (
                      <div className="text-slate-500">读取中…</div>
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
            <h3 className="font-semibold mb-3">1. 注册本类全部装备</h3>
            <p className="text-xs text-slate-400 mb-4">
              将 30 件 {TABS.find((t) => t.key === tab)?.label}装备注册到 DIDParts 合约。每笔注册需要钱包确认一次交易。
            </p>
            {regProgress ? (
              <div className="space-y-2">
                <div className="text-sm text-neon-cyan">
                  注册中 {regProgress.current}/{regProgress.total}：{regProgress.name}
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
                注册 {TABS.find((t) => t.key === tab)?.label} (30 笔)
              </button>
            )}
          </div>

          <div className="glass p-5">
            <h3 className="font-semibold mb-3">2. 按稀有度铸造本类</h3>
            <div className="mb-4">
              <label className="text-xs text-slate-400">接收地址</label>
              <input
                className="input mt-1"
                placeholder="0x... 留空则发给自己"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
              {!recipient.trim() && (
                <p className="text-[10px] text-slate-500 mt-1">留空将铸造到当前连接地址</p>
              )}
            </div>

            <div className="space-y-3 mb-4">
              {RARITIES.map((rarity) => (
                <div key={rarity} className="flex items-center justify-between">
                  <span className={`text-xs ${rarityStyle[rarity]}`}>{rarityDot[rarity]} {rarity}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500">每件铸造</span>
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
                    <span className="text-[10px] text-slate-500">份</span>
                  </div>
                </div>
              ))}
            </div>

            {mintProgress ? (
              <div className="space-y-2">
                <div className="text-sm text-neon-cyan">
                  铸造中 {mintProgress.current}/{mintProgress.total}：{mintProgress.rarity}
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
                铸造 {TABS.find((t) => t.key === tab)?.label}
              </button>
            )}

            <p className="text-[10px] text-slate-500 mt-3 leading-relaxed">
              系统会按 普通/稀有/史诗/传说 分 4 组，每组调用一次 mintPartBatch。已注册且未超过 maxSupply 的装备才会被铸造。
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
