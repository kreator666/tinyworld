import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Equipped, NFTCategory, ChainType, NFTItem } from '../types'
import { nftLibrary } from '../mock/data'
import { CHARACTERS } from '../data/characterCatalog'
import { useAppStore } from '../store/appStore'
import { useChainStore } from '../store/chainStore'
import PaperDoll from '../components/PaperDoll'
import NFTCard from '../components/NFTCard'
import { explorerTx, TARGET_CHAIN_ID, partByLocalId } from '../lib/contracts'

const tabs: { key: NFTCategory; label: string; desc: string }[] = [
  { key: 'head', label: '头部', desc: '角色头部形象(v4 角色库)' },
  { key: 'body', label: '身体', desc: '角色身体造型(v4 角色库)' },
  { key: 'accessory', label: '配饰', desc: '全屏背景 / 氛围 / 披风 / 光翼' },
  { key: 'pet', label: '宠物', desc: '跟随小伙伴(显示在人物身前)' },
]

const SLOT_MAP: Record<NFTCategory, number> = { head: 0, body: 1, accessory: 2, pet: 3 }

const takenNames = ['satoshi', 'vitalik', 'aiko_02', 'neonhunter']

type MintPhase = 'idle' | 'signing' | 'confirming' | 'done' | 'error'

// 把 v4 角色库映射为 head-N / body-N 的展示项,保持与链上 part ID 一一对应
function buildCharacterItems(): NFTItem[] {
  return CHARACTERS.flatMap((char) => {
    const index = char.id.split('-')[1]
    const baseHead = nftLibrary.find((i) => i.id === `head-${index}`)
    const baseBody = nftLibrary.find((i) => i.id === `body-${index}`)
    const items: NFTItem[] = []
    if (baseHead) {
      items.push({
        ...baseHead,
        name: `角色 ${index}`,
        imageUrl: char.headUrl,
      })
    }
    if (baseBody) {
      items.push({
        ...baseBody,
        name: `角色 ${index}`,
        imageUrl: char.bodyUrl,
      })
    }
    return items
  })
}

// 铸造工坊:v4 角色 head/body + 装备 accessory/pet,链上交互与合约逻辑保持不变
export default function MintWorkshop() {
  const nav = useNavigate()
  const { connected, address, login, mintDID, showToast } = useAppStore()
  const { tokenId, didName, equipped: chainEquipped, parts, refresh, mint, isAdmin } = useChainStore()

  const [tab, setTab] = useState<NFTCategory>('head')
  const [equipped, setEquipped] = useState<Equipped>(
    chainEquipped ?? { head: 'head-1', body: 'body-1', accessory: null, pet: null },
  )
  const [name, setName] = useState(didName ?? '')
  const [bio, setBio] = useState('')
  const [phase, setPhase] = useState<MintPhase>('idle')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [isSepolia, setIsSepolia] = useState(false)
  const [previewInit, setPreviewInit] = useState(false)

  useEffect(() => {
    const sepolia = login?.chainId === TARGET_CHAIN_ID
    setIsSepolia(sepolia)
    if (connected && sepolia && address) refresh(address as `0x${string}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, login?.chainId, address])

  useEffect(() => {
    if (chainEquipped) setEquipped(chainEquipped)
  }, [chainEquipped])

  // 切换钱包后重置预览初始化状态,让新钱包的持有装备能重新成为默认预览
  useEffect(() => {
    setPreviewInit(false)
  }, [address])

  // 初次读到链上配件时,把预览默认设为每分类第一件已持有的本地装备
  useEffect(() => {
    if (previewInit || !isSepolia || parts.length === 0) return
    const next: Equipped = { head: null, body: null, accessory: null, pet: null }
    ;(Object.keys(SLOT_MAP) as NFTCategory[]).forEach((cat) => {
      const slot = SLOT_MAP[cat]
      const owned = parts.find((p) => p.slot === slot && p.balance > 0)
      if (owned) next[cat] = owned.localId
    })
    // 保底默认角色
    if (!next.head) next.head = 'head-1'
    if (!next.body) next.body = 'body-1'
    setEquipped(next)
    setPreviewInit(true)
  }, [isSepolia, parts, previewInit])

  const nameTaken = name.trim().length > 0 && takenNames.includes(name.trim().toLowerCase())
  const nameOk = name.trim().length >= 2 && !nameTaken

  // v4 角色 head/body 展示项
  const characterItems = useMemo(() => buildCharacterItems(), [])

  // 装备 accessory/pet 目录;连接 Sepolia 后,对已在链上注册并有余额的装备覆盖 owned/count/chain 标记
  const equipmentItems = useMemo(() => {
    const base = nftLibrary.filter((i) => i.category === 'accessory' || i.category === 'pet')
    if (!isSepolia) return base
    return base.map((item) => {
      const cp = partByLocalId(item.id)
      if (!cp) return item
      const chain = parts.find((p) => p.id === cp.id)
      return {
        ...item,
        owned: chain ? chain.balance > 0 : item.owned,
        count: chain?.balance ?? 0,
        chain: 'Sepolia' as ChainType,
      }
    })
  }, [isSepolia, parts])

  // head/body 展示项同样覆盖链上持有状态
  const characterCatalogItems = useMemo(() => {
    if (!isSepolia) return characterItems
    return characterItems.map((item) => {
      const cp = partByLocalId(item.id)
      if (!cp) return item
      const chain = parts.find((p) => p.id === cp.id)
      return {
        ...item,
        owned: chain ? chain.balance > 0 : item.owned,
        count: chain?.balance ?? 0,
        chain: 'Sepolia' as ChainType,
      }
    })
  }, [isSepolia, parts, characterItems])

  // 当前标签页要渲染的卡片
  const categoryItems = useMemo(() => {
    if (tab === 'head' || tab === 'body') return characterCatalogItems.filter((i) => i.category === tab)
    return equipmentItems.filter((i) => i.category === tab)
  }, [tab, characterCatalogItems, equipmentItems])

  // 所有展示项,用于右侧“当前预览搭配”
  const allItems = useMemo(() => [...characterCatalogItems, ...equipmentItems], [characterCatalogItems, equipmentItems])

  const selectedItems = useMemo(
    () => Object.values(equipped).map((id) => allItems.find((i) => i.id === id)).filter((i): i is NonNullable<typeof i> => !!i),
    [equipped, allItems],
  )

  const pick = (id: string, category: NFTCategory) =>
    setEquipped((e) => ({ ...e, [category]: e[category] === id ? null : id }))

  const handleBuy = (item: NFTItem) => {
    if (isAdmin) {
      nav('/admin')
      showToast(`请前往管理员后台发行「${item.name}」`)
      return
    }
    showToast(`「${item.name}」尚未持有，购买市场合约未部署`)
  }

  const doMint = async () => {
    if (!nameOk || !address || !isSepolia) return
    setPhase('signing')
    setErrorMsg(null)
    try {
      const hash = await mint(address as `0x${string}`, name.trim(), bio.trim())
      setTxHash(hash)
      setPhase('confirming')
      // 本地镜像:让个人主页/导航继续可用
      mintDID(name.trim(), bio.trim(), 'ETH', equipped)
      setPhase('done')
      setTimeout(() => {
        showToast('🎉 DID 身份 NFT 已上链!配件可在资产背包中穿戴')
        nav('/backpack')
      }, 1400)
    } catch (err) {
      setPhase('error')
      setErrorMsg(err instanceof Error ? err.message : '链上铸造失败')
    }
  }

  const alreadyMinted = tokenId > 0

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h2 className="text-2xl font-bold mb-1">NFT 铸造工坊</h2>
      <p className="text-sm text-slate-400 mb-6">
        {alreadyMinted
          ? '你已铸造 DID 主身份 NFT,可在资产背包查看链上资产'
          : '挑选 NFT 组件预览搭配,并在 Sepolia 测试网铸造 DID 主身份'}
      </p>

      {alreadyMinted && (
        <div className="glass neon-border p-6 max-w-2xl mb-6">
          <div className="flex items-center gap-4">
            <span className="w-14 h-14 rounded-xl bg-neon-grad grid place-items-center text-2xl shadow-neon-purple">🪪</span>
            <div>
              <div className="font-semibold text-lg">{didName} · 已铸造</div>
              <div className="text-xs text-slate-500 font-mono mt-0.5">tokenId: {tokenId}</div>
            </div>
          </div>
          <div className="mt-4 flex gap-3">
            <button className="btn-primary" onClick={() => nav('/backpack')}>查看资产背包</button>
            <button className="btn-ghost" onClick={() => nav('/profile')}>去个人主页</button>
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-[280px_1fr_300px] gap-6">
        {/* 左栏:纸娃娃实时预览 */}
        <div className="glass p-5 flex flex-col items-center">
          <div className="text-sm text-slate-400 mb-3 self-start">实时预览</div>
          <PaperDoll equipped={equipped} size="lg" interactive />
          <div className="w-full mt-5 pt-4 border-t border-white/10 space-y-2 text-sm">
            <div className="flex justify-between text-slate-400">
              <span>网络</span><span className="font-mono text-neon-cyan">{isSepolia ? 'Sepolia' : '未连接 Sepolia'}</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>已选组件</span><span>{selectedItems.length} 件</span>
            </div>
            <button
              className="btn-primary w-full mt-2"
              disabled={phase !== 'idle' || alreadyMinted || !connected || !isSepolia || !nameOk}
              onClick={doMint}
            >
              {alreadyMinted ? '已铸造' : '铸造专属 DID 身份 NFT'}
            </button>
            {!connected && <p className="text-xs text-rose-400 mt-1">请先连接钱包</p>}
            {connected && !isSepolia && <p className="text-xs text-amber-400 mt-1">请先切换到 Sepolia 网络</p>}
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
          <p className="text-xs text-slate-500 mb-4">
            {isSepolia
              ? `${tabs.find((t) => t.key === tab)?.desc}(已连接 Sepolia: 显示链上持有状态)`
              : `${tabs.find((t) => t.key === tab)?.desc}(演示目录,连接钱包后显示链上持有状态)`}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {categoryItems.map((i) => (
              <NFTCard
                key={i.id}
                item={i}
                selected={equipped[tab] === i.id}
                onClick={() => pick(i.id, tab)}
                actions={
                  !i.owned && isSepolia ? (
                    <button
                      className="btn-primary !px-2 !py-1 text-[10px]"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleBuy(i)
                      }}
                    >
                      {isAdmin ? '去发行' : '购买'}
                    </button>
                  ) : undefined
                }
              />
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-4">
            💡 选择组件仅影响当前预览;铸造后可在资产背包中把已持有的配件穿到 DID 上
          </p>
        </div>

        {/* 右栏:铸造参数 + 预览搭配 */}
        <div className="glass p-5 space-y-4 h-fit">
          <div>
            <label className="text-xs text-slate-400">DID 身份名称(链上永久,不可重复)</label>
            <input className="input mt-1" placeholder="输入 2 个字符以上" value={name} onChange={(e) => setName(e.target.value)} disabled={alreadyMinted} />
            {nameTaken && <p className="text-xs text-rose-400 mt-1">✕ 该名称已被占用(本地校验)</p>}
            {nameOk && <p className="text-xs text-emerald-400 mt-1">✓ 名称可用</p>}
          </div>
          <div>
            <label className="text-xs text-slate-400">身份简介(profileURI,同步到个人主页)</label>
            <textarea className="input mt-1 h-20 resize-none" placeholder="介绍一下你的链上身份…" value={bio} onChange={(e) => setBio(e.target.value)} disabled={alreadyMinted} />
          </div>
          <div>
            <label className="text-xs text-slate-400">选择公链</label>
            <div className="flex gap-2 mt-1">
              <span className="flex-1 px-2 py-2 rounded-xl text-xs bg-neon-grad text-white text-center">Sepolia(ETH 测试网)</span>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400">铸造数量</label>
            <div className="input mt-1 text-slate-500 text-xs">1 份专属 DID 主 NFT(每地址限 1 枚)</div>
          </div>
          {/* 当前预览搭配 */}
          <div className="border-t border-white/10 pt-3">
            <label className="text-xs text-slate-400">当前预览搭配</label>
            <div className="mt-1.5 space-y-1.5">
              {selectedItems.length === 0 && <p className="text-xs text-slate-500">未选择任何配件</p>}
              {selectedItems.map((i) => (
                <div key={i.id} className="flex items-center justify-between text-xs">
                  <span className="text-slate-300">{i.emoji} {i.name}</span>
                  <span className={i.owned ? 'text-emerald-400' : 'text-slate-500'}>
                    {i.owned ? `✓ 已持有${i.count && i.count > 1 ? ` ×${i.count}` : ''}` : '未持有'}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="border-t border-white/10 pt-3">
            <p className="text-[11px] text-slate-500 leading-relaxed">
              确认铸造后钱包会弹出真实交易,仅消耗 Sepolia 测试 Gas。配件需先在资产背包中持有,才能通过链上“穿戴”挂到 DID 上。
            </p>
          </div>
          <button
            className="btn-primary w-full"
            disabled={!nameOk || phase !== 'idle' || alreadyMinted || !connected || !isSepolia}
            onClick={doMint}
          >
            {alreadyMinted ? '已铸造' : '确认铸造'}
          </button>
        </div>
      </div>

      {/* 链上交易进度弹窗 */}
      {phase !== 'idle' && phase !== 'error' && (
        <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm grid place-items-center p-4">
          <div className="glass neon-border w-full max-w-sm p-8 text-center">
            {phase === 'done' ? (
              <>
                <div className="text-5xl">🎉</div>
                <p className="mt-3 font-semibold">DID 身份 NFT 已上链</p>
                <p className="text-xs text-slate-400 mt-1">正在跳转资产背包…</p>
              </>
            ) : (
              <>
                <div className="w-14 h-14 mx-auto rounded-full border-2 border-neon-purple border-t-transparent animate-spin" />
                <p className="mt-4 font-medium">{phase === 'signing' ? '等待钱包签名…' : '交易上链确认中…'}</p>
                {txHash && (
                  <p className="text-xs text-slate-500 mt-2 font-mono">
                    tx: <a className="text-neon-cyan hover:underline" href={explorerTx(txHash)} target="_blank" rel="noreferrer">{txHash.slice(0, 18)}…</a>
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm grid place-items-center p-4">
          <div className="glass border border-rose-500/40 w-full max-w-sm p-8 text-center">
            <div className="text-5xl">⚠️</div>
            <p className="mt-3 font-semibold text-rose-400">铸造失败</p>
            <p className="text-sm text-slate-300 mt-2">{errorMsg}</p>
            <button className="btn-primary mt-5" onClick={() => setPhase('idle')}>重试</button>
          </div>
        </div>
      )}
    </div>
  )
}
