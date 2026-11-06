import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Equipped } from '../types'
import { useAppStore } from '../store/appStore'
import { useChainStore } from '../store/chainStore'
import PaperDoll from '../components/PaperDoll'
import { explorerTx, useChainConfig } from '../store/chainConfigStore'
import { checkNameAvailable, isWalletOnActiveChain } from '../lib/chainDispatch'
import { useI18n } from '../i18n'

const takenNames = ['satoshi', 'vitalik', 'aiko_02', 'neonhunter'] // 未连接目标链时的本地演示兜底

// 新身份铸造后的默认形象(装备由新手大礼包随机发放并自动穿戴,见资产背包)
const DEFAULT_EQUIPPED: Equipped = { head: 'head-1', body: 'body-1', accessory: null, pet: null }

type MintPhase = 'idle' | 'signing' | 'confirming' | 'done' | 'error'

// 铸造工坊:只铸 DID 主身份;装备不经此页发放——新用户去资产背包开「新手大礼包」
// (链上随机四件套 + 自动穿戴),避免"选了装备却铸不出来"的误导
export default function MintWorkshop() {
  const { t } = useI18n()
  const active = useChainConfig((s) => s.active)
  const nav = useNavigate()
  const { connected, address, login, mintDID, showToast } = useAppStore()
  const { tokenId, didName, refresh, mint } = useChainStore()

  const [name, setName] = useState(didName ?? '')
  const [bio, setBio] = useState('')
  const [phase, setPhase] = useState<MintPhase>('idle')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [onTargetChain, setOnTargetChain] = useState(false)
  // 链上名称查重结果:null = 未校验/校验中
  const [chainNameAvailable, setChainNameAvailable] = useState<boolean | null>(null)

  // 连接目标链后,名称查重走合约 nameAvailable(防抖 400ms;RPC 异常时不阻塞,由链上 mint 兜底)
  useEffect(() => {
    const trimmed = name.trim()
    if (!connected || !onTargetChain || trimmed.length < 2) {
      setChainNameAvailable(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const ok = await checkNameAvailable(trimmed)
        if (!cancelled) setChainNameAvailable(ok)
      } catch {
        if (!cancelled) setChainNameAvailable(null)
      }
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [name, connected, onTargetChain, active.key])

  useEffect(() => {
    const on = isWalletOnActiveChain(login, active)
    setOnTargetChain(on)
    if (connected && on && address) refresh(address)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, login?.chainId, active.chainId, address])

  const nameTaken =
    chainNameAvailable === false ||
    (chainNameAvailable === null && name.trim().length > 0 && takenNames.includes(name.trim().toLowerCase()))
  const nameOk = name.trim().length >= 2 && !nameTaken

  const doMint = async () => {
    if (!nameOk || !address || !onTargetChain) return
    setPhase('signing')
    setErrorMsg(null)
    try {
      const hash = await mint(address, name.trim(), bio.trim())
      setTxHash(hash as string)
      setPhase('confirming')
      // 本地镜像:让个人主页/导航继续可用
      mintDID(name.trim(), bio.trim(), active.name, DEFAULT_EQUIPPED)
      setPhase('done')
      setTimeout(() => {
        showToast(t('mint.toastSuccess'))
        nav('/backpack')
      }, 1400)
    } catch (err) {
      setPhase('error')
      setErrorMsg(err instanceof Error ? err.message : t('mint.fail'))
    }
  }

  const alreadyMinted = tokenId > 0

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <h2 className="text-2xl font-bold mb-1">{t('mint.title')}</h2>
      <p className="text-sm text-slate-400 mb-6">
        {alreadyMinted
          ? t('mint.subtitleMinted')
          : t('mint.subtitleNew', { name: active.name })}
      </p>

      {alreadyMinted && (
        <div className="glass neon-border p-6 max-w-2xl mb-6">
          <div className="flex items-center gap-4">
            <span className="w-14 h-14 rounded-xl bg-neon-grad grid place-items-center text-2xl shadow-neon-purple">🪪</span>
            <div>
              <div className="font-semibold text-lg">{t('mint.mintedBadge', { name: didName })}</div>
              <div className="text-xs text-slate-500 font-mono mt-0.5">tokenId: {tokenId}</div>
            </div>
          </div>
          <div className="mt-4 flex gap-3">
            <button className="btn-primary" onClick={() => nav('/backpack')}>{t('mint.viewBackpack')}</button>
            <button className="btn-ghost" onClick={() => nav('/profile')}>{t('mint.goProfile')}</button>
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-[300px_1fr] gap-6">
        {/* 左栏:默认形象预览 */}
        <div className="glass p-5 flex flex-col items-center">
          <div className="text-sm text-slate-400 mb-3 self-start">{t('mint.preview')}</div>
          <PaperDoll equipped={DEFAULT_EQUIPPED} size="lg" />
          <div className="w-full mt-5 pt-4 border-t border-white/10 space-y-2 text-sm">
            <div className="flex justify-between text-slate-400">
              <span>{t('mint.network')}</span><span className="font-mono text-neon-cyan">{onTargetChain ? active.name : t('mint.notConnected', { name: active.name })}</span>
            </div>
            <div className="text-xs text-slate-500 leading-relaxed">
              {t('mint.slotsHint')}
            </div>
            <button
              className="btn-primary w-full mt-2"
              disabled={phase !== 'idle' || alreadyMinted || !connected || !onTargetChain || !nameOk}
              onClick={doMint}
            >
              {alreadyMinted ? t('mint.minted') : t('mint.mintBtn')}
            </button>
            {!connected && <p className="text-xs text-rose-400 mt-1">{t('mint.connectFirst')}</p>}
            {connected && !onTargetChain && <p className="text-xs text-amber-400 mt-1">{t('mint.switchNetwork', { name: active.name })}</p>}
          </div>
        </div>

        {/* 右栏:铸造参数 */}
        <div className="glass p-5 space-y-4 h-fit">
          <div>
            <label className="text-xs text-slate-400">{t('mint.nameLabel')}</label>
            <input className="input mt-1" placeholder={t('mint.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} disabled={alreadyMinted} />
            {nameTaken && <p className="text-xs text-rose-400 mt-1">{onTargetChain ? t('mint.nameTakenOnChain') : t('mint.nameTakenLocal')}</p>}
            {nameOk && <p className="text-xs text-emerald-400 mt-1">{onTargetChain && chainNameAvailable === true ? t('mint.nameOkConfirmed') : t('mint.nameOk')}</p>}
          </div>
          <div>
            <label className="text-xs text-slate-400">{t('mint.bioLabel')}</label>
            <textarea className="input mt-1 h-20 resize-none" placeholder={t('mint.bioPlaceholder')} value={bio} onChange={(e) => setBio(e.target.value)} disabled={alreadyMinted} />
          </div>
          <div>
            <label className="text-xs text-slate-400">{t('mint.chainLabel')}</label>
            <div className="flex gap-2 mt-1">
              <span className="flex-1 px-2 py-2 rounded-xl text-xs bg-neon-grad text-white text-center">{active.name}</span>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400">{t('mint.contentLabel')}</label>
            <div className="input mt-1 text-slate-500 text-xs">{t('mint.content')}</div>
          </div>
          <div className="border-t border-white/10 pt-3">
            <p className="text-[11px] text-slate-500 leading-relaxed">
              {t('mint.footerNote', { name: active.name })}
            </p>
          </div>
          <button
            className="btn-primary w-full"
            disabled={!nameOk || phase !== 'idle' || alreadyMinted || !connected || !onTargetChain}
            onClick={doMint}
          >
            {alreadyMinted ? t('mint.minted') : t('mint.confirmBtn')}
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
                <p className="mt-3 font-semibold">{t('mint.doneTitle')}</p>
                <p className="text-xs text-slate-400 mt-1">{t('mint.doneHint')}</p>
              </>
            ) : (
              <>
                <div className="w-14 h-14 mx-auto rounded-full border-2 border-neon-purple border-t-transparent animate-spin" />
                <p className="mt-4 font-medium">{phase === 'signing' ? t('mint.signing') : t('mint.confirming')}</p>
                {txHash && (
                  <p className="text-xs text-slate-500 mt-2 font-mono">
                    tx: <a className="text-neon-cyan hover:underline" href={explorerTx(txHash)} target="_blank" rel="noreferrer">{txHash.slice(0, 18)}…</a>
                  </p>
                )}
                {/* 签名/确认可能因钱包弹窗被忽略或插件冲突而永久挂起,允许手动关闭 */}
                <button className="btn-ghost mt-5 !text-xs" onClick={() => setPhase('idle')}>{t('mint.cancel')}</button>
              </>
            )}
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm grid place-items-center p-4">
          <div className="glass border border-rose-500/40 w-full max-w-sm p-8 text-center">
            <div className="text-5xl">⚠️</div>
            <p className="mt-3 font-semibold text-rose-400">{t('mint.errorTitle')}</p>
            <p className="text-sm text-slate-300 mt-2">{errorMsg}</p>
            <button className="btn-primary mt-5" onClick={() => setPhase('idle')}>{t('mint.retry')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
