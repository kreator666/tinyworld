import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../i18n'
import { useAppStore } from '../store/appStore'
import { useChainStore } from '../store/chainStore'
import { useChainConfig, explorerTx } from '../store/chainConfigStore'
import {
  adoptSurvivalTxs,
  cleanSurvivalPet,
  confirmSurvivalAdopt,
  confirmSurvivalFeed,
  feedSurvivalTxs,
  formatNear,
  getSurvivalActions,
  getSurvivalLeaderboard,
  getSurvivalPet,
  getSurvivalPositions,
  reviveSurvivalConfirm,
  reviveSurvivalTxs,
  survivalAction,
  SurvivalApiError,
  type SurvivalActionDto,
  type SurvivalActionKind,
  type SurvivalFeedAmount,
  type SurvivalLeaderboardEntry,
  type SurvivalPetDto,
  type SurvivalPetStatus,
  type SurvivalPositionDto,
} from '../lib/survivalApi'
import { sendTransactions } from '../lib/chainDispatch'
import SurvivalRoom, { type HotspotKind, type SurvivalOutcome } from '../components/SurvivalRoom'

// ============================================================
// 生存模式(Survival Mode):电子宠物式全图形化页面
// 左:Canvas 房间场景(点物品互动) 右:状态面板 + 动作日志 下:排行榜(可折叠)
// 数据:15s 轮询 pet + 动作日志;动作同步执行 10-30s,期间画布锁交互
// 入口仅 NEAR 链(NavBar 条件渲染;直接输 URL 也由本页兜底提示)
// ============================================================

const POLL_MS = 15_000
const PRINCIPAL_OPTIONS = [1, 2, 5] as const
const FEED_OPTIONS: SurvivalFeedAmount[] = [0.1, 0.2, 0.5]

/** 画布动作弹窗的待确认动作(heal 直走不弹窗;revive 走面板按钮的独立弹窗) */
type PendingAction = { kind: 'feed' } | { kind: 'clean' } | { kind: 'work' } | { kind: 'revive' }

const KIND_ICON: Record<SurvivalActionKind, string> = { feed: '🍖', clean: '🧹', work: '💻', heal: '💊' }
/** 资金分配仓位 kind → 图标(默认 💰) */
const POSITION_ICON: Record<string, string> = { usdc_reserve: '💵', lending: '🏦', nearai_farm: '🌾' }
const STATUS_DOT: Record<SurvivalActionDto['status'], string> = {
  executed: 'bg-emerald-400',
  rejected: 'bg-amber-400',
  failed: 'bg-red-400',
  planned: 'bg-slate-400',
}
const PET_STATUS_CLS: Record<SurvivalPetStatus, string> = {
  alive: 'bg-emerald-500/20 text-emerald-300',
  weak: 'bg-amber-500/20 text-amber-300',
  dormant: 'bg-sky-500/20 text-sky-300',
  dead: 'bg-slate-500/20 text-slate-400',
}

const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 仓位金额展示:原子单位按 token 精度换算(NEAR 系 1e24,USDC 1e6) */
const fmtAmount = (atomic: string, token: string) => {
  const decimals = token === 'USDC' ? 6 : 24
  const n = Number(BigInt(atomic) / 10n ** BigInt(decimals - 4)) / 10 ** 4
  if (!Number.isFinite(n)) return atomic
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (Math.abs(n) >= 1) return n.toFixed(2)
  return n.toPrecision(3)
}

/** 状态条配色:饱食/清洁/心情/生命 */
const STAT_BARS: { key: keyof SurvivalPetDto['stats']; cls: string }[] = [
  { key: 'satiety', cls: 'from-amber-400 to-orange-500' },
  { key: 'cleanliness', cls: 'from-cyan-400 to-sky-500' },
  { key: 'mood', cls: 'from-pink-400 to-fuchsia-500' },
  { key: 'vitality', cls: 'from-emerald-400 to-green-600' },
]

/** 年龄(小时)→ 本地文案:满 48h 用天 */
function useAgeLabel() {
  const { t } = useI18n()
  return (ageHours: number) =>
    ageHours >= 48 ? t('survival.board.ageDays', { v: (ageHours / 24).toFixed(1) }) : t('survival.board.ageHours', { v: ageHours.toFixed(1) })
}

export default function SurvivalPage() {
  const { t } = useI18n()
  const { showToast, address } = useAppStore()
  const { active } = useChainConfig()
  const { tokenId, didName, equipped } = useChainStore()
  const isNear = active.family === 'near'

  const [pet, setPet] = useState<SurvivalPetDto | null>(null)
  const [petChecked, setPetChecked] = useState(false) // 首屏拉取完成(区分加载中与未领养)
  const [actions, setActions] = useState<SurvivalActionDto[]>([])
  const [positions, setPositions] = useState<SurvivalPositionDto[]>([])
  const [board, setBoard] = useState<SurvivalLeaderboardEntry[]>([])
  const [boardOpen, setBoardOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [adoptStage, setAdoptStage] = useState<'build' | 'sign' | 'confirm' | 'allocate' | null>(null)
  const [reviving, setReviving] = useState(false)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [feedAmount, setFeedAmount] = useState<SurvivalFeedAmount>(0.1)
  const [principal, setPrincipal] = useState<1 | 2 | 5>(1)
  const [outcome, setOutcome] = useState<SurvivalOutcome | null>(null)
  const seqRef = useRef(0)
  const ageLabel = useAgeLabel()

  const roomLabels = useMemo<Record<HotspotKind, string>>(
    () => ({
      feed: t('survival.action.feed'),
      clean: t('survival.action.clean'),
      work: t('survival.action.work'),
      heal: t('survival.action.heal'),
      bed: t('survival.action.bed'),
    }),
    [t],
  )

  const refreshPositions = useCallback(async () => {
    if (tokenId <= 0) return
    try {
      const r = await getSurvivalPositions(tokenId)
      setPositions(r.positions)
    } catch {
      // 仓位拉取失败静默:下一轮轮询补齐
    }
  }, [tokenId])

  const refreshPet = useCallback(async () => {
    if (tokenId <= 0) return
    try {
      const r = await getSurvivalPet(tokenId)
      setPet(r.pet)
      if (r.pet) refreshPositions()
    } catch {
      // 服务不可达/接口未上线:保持现状,不打断页面
    } finally {
      setPetChecked(true)
    }
  }, [tokenId, refreshPositions])

  const refreshActions = useCallback(async () => {
    if (tokenId <= 0) return
    try {
      const r = await getSurvivalActions(tokenId, 20)
      setActions(r.actions)
    } catch {
      // 动作日志拉取失败静默:下一轮轮询补齐
    }
  }, [tokenId])

  const refreshBoard = useCallback(async () => {
    try {
      const r = await getSurvivalLeaderboard(50)
      setBoard(r.entries)
    } catch {
      // 排行榜拉取失败静默
    }
  }, [])

  // 15s 轮询:状态 + 动作日志;排行榜低频跟一次
  useEffect(() => {
    if (!isNear || tokenId <= 0) return
    refreshPet()
    refreshActions()
    refreshBoard()
    const timer = setInterval(() => {
      refreshPet()
      refreshActions()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [isNear, tokenId, refreshPet, refreshActions, refreshBoard])

  // 统一动作报错提示:401 弹登录、网关错误降级,其余透传后端 message(如 clean 409 暂无收益)
  const toastActionError = useCallback(
    (err: unknown) => {
      if (err instanceof SurvivalApiError && err.status === 401) {
        showToast(t('survival.toast.needLogin'))
      } else if (err instanceof SurvivalApiError && (err.status >= 502 || err.status === 408)) {
        showToast(t('survival.toast.noResponse'))
      } else {
        showToast(err instanceof Error ? err.message : t('survival.toast.actionFail'))
      }
    },
    [showToast, t],
  )

  // 点击画布热点:这里只接收「动作意图」——feed/clean/work 先弹确认窗,heal 直走;冷却/沉睡/死亡在画布层已拦截
  const onAction = useCallback(
    (kind: SurvivalActionKind) => {
      if (busy || tokenId <= 0 || pending) return
      if (kind === 'heal') {
        void executeAction('heal')
        return
      }
      setPending({ kind })
    },
    [busy, tokenId, pending],
  )

  // 关闭弹窗:宠物已经走向物品,给一个失败态 outcome 让画布快速收尾(避免空等到 60s 看门狗)
  const cancelPending = useCallback(() => {
    if (pending && pending.kind !== 'revive') {
      setOutcome({ kind: pending.kind, ok: false, seq: ++seqRef.current })
    }
    setPending(null)
  }, [pending])

  // work/heal:保留原同步 action 流程(接口 10-30s,期间画布锁交互)
  async function executeAction(kind: 'work' | 'heal') {
    if (busy || tokenId <= 0) return
    setPending(null)
    setBusy(true)
    const seq = ++seqRef.current
    setOutcome(null)
    try {
      const r = await survivalAction(tokenId, kind)
      const ok = r.action.status === 'executed'
      setOutcome({ kind, ok, seq })
      if (!ok) showToast(t('survival.toast.rejected'))
      else if (kind === 'heal') showToast(t('survival.heal.success'))
    } catch (err) {
      setOutcome({ kind, ok: false, seq })
      toastActionError(err)
    } finally {
      setBusy(false)
      refreshPet()
      refreshActions()
    }
  }

  // 喂食:feedTxs → 钱包签名自广播 → feedConfirm;新本金来自用户钱包,需钱包签名
  async function executeFeed() {
    if (busy || tokenId <= 0 || !address) return
    setPending(null)
    setBusy(true)
    const seq = ++seqRef.current
    const amount = feedAmount
    setOutcome(null)
    try {
      const r = await feedSurvivalTxs(tokenId, amount)
      if (!r.txs.length) throw new Error(t('survival.toast.actionFail'))
      const hashes = await sendTransactions(address, r.txs)
      if (!hashes.length) throw new Error(t('chainMsg.near.noTxHash'))
      const c = await confirmSurvivalFeed(tokenId, hashes[0])
      if (c.pet) setPet(c.pet)
      refreshPositions()
      setOutcome({ kind: 'feed', ok: true, seq })
      showToast(t('survival.feed.success', { x: amount }))
      if (c.failures.length > 0) showToast(t('survival.toast.allocPartial'))
    } catch (err) {
      setOutcome({ kind: 'feed', ok: false, seq })
      toastActionError(err)
    } finally {
      setBusy(false)
      refreshPet()
      refreshActions()
    }
  }

  // 打扫:提取借贷收益到宠物金库(仅收益部分);同步执行 10-30s,409 = 无可提取收益
  async function executeClean() {
    if (busy || tokenId <= 0) return
    setPending(null)
    setBusy(true)
    const seq = ++seqRef.current
    setOutcome(null)
    try {
      const r = await cleanSurvivalPet(tokenId)
      setOutcome({ kind: 'clean', ok: true, seq })
      showToast(t('survival.clean.success', { x: formatNear(r.claimedYocto) }))
    } catch (err) {
      setOutcome({ kind: 'clean', ok: false, seq })
      toastActionError(err)
    } finally {
      setBusy(false)
      refreshPet()
      refreshActions()
    }
  }

  const onDormantClick = useCallback(() => showToast(t('survival.toast.dormant')), [showToast, t])
  const onBusyClick = useCallback(() => showToast(t('survival.toast.busy')), [showToast, t])

  const onAdopt = async () => {
    if (adoptStage || tokenId <= 0 || !address) return
    setAdoptStage('build')
    try {
      // 1) 后端组装领养交易(含用户自费的领养费转账)
      const r = await adoptSurvivalTxs(tokenId, principal)
      if (!r.txs.length) throw new Error(t('survival.toast.adoptFail'))
      // 2) 逐笔交钱包签名自广播(会弹 Meteor 等钱包;网页重定向钱包不支持,sendTransactions 抛中文错)
      setAdoptStage('sign')
      const hashes = await sendTransactions(address, r.txs)
      if (!hashes.length) throw new Error(t('chainMsg.near.noTxHash'))
      // 3) 确认上链 + 后端登记宠物并分配领养费
      setAdoptStage('confirm')
      const c = await confirmSurvivalAdopt(tokenId, hashes[0])
      setAdoptStage('allocate')
      setPet(c.pet)
      setPositions(c.positions)
      await refreshPet() // 重新拉取宠物与仓位,确认分配落库后再放开按钮
      showToast(t('survival.toast.adoptOk'))
      if (c.failures.length > 0) showToast(t('survival.toast.allocPartial'))
      refreshActions()
    } catch (err) {
      if (err instanceof SurvivalApiError && err.status === 401) showToast(t('survival.toast.needLogin'))
      else showToast(err instanceof Error ? err.message : t('survival.toast.adoptFail'))
    } finally {
      setAdoptStage(null)
    }
  }

  // 复活:reviveTxs → 钱包签名自广播 → reviveConfirm;0.5 NEAR 从用户钱包转出充值算力,本金与收益保留
  const onRevive = async () => {
    if (reviving || tokenId <= 0 || !address) return
    setPending(null)
    setReviving(true)
    try {
      const r = await reviveSurvivalTxs(tokenId)
      if (!r.txs.length) throw new Error(t('survival.toast.reviveFail'))
      const hashes = await sendTransactions(address, r.txs)
      if (!hashes.length) throw new Error(t('chainMsg.near.noTxHash'))
      const c = await reviveSurvivalConfirm(tokenId, hashes[0])
      setPet(c.pet)
      showToast(t('survival.revive.success'))
      refreshActions()
    } catch (err) {
      if (err instanceof SurvivalApiError && err.status === 401) showToast(t('survival.toast.needLogin'))
      else showToast(err instanceof Error ? err.message : t('survival.toast.reviveFail'))
    } finally {
      setReviving(false)
      refreshPet()
    }
  }

  // ---------------- 页面状态分支 ----------------

  if (!isNear) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <div className="glass neon-border p-10 text-center">
          <p className="text-4xl mb-4">⛓</p>
          <h1 className="text-xl font-bold mb-2">{t('survival.needNear.title')}</h1>
          <p className="text-sm text-slate-400">{t('survival.needNear.desc')}</p>
        </div>
      </div>
    )
  }

  if (tokenId <= 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <div className="glass neon-border p-10 text-center">
          <p className="text-4xl mb-4">🐣</p>
          <h1 className="text-xl font-bold mb-2">{t('survival.needDid.title')}</h1>
          <p className="text-sm text-slate-400 mb-6">{t('survival.needDid.desc')}</p>
          <Link to="/mint" className="btn-primary inline-block">{t('survival.needDid.cta')}</Link>
        </div>
      </div>
    )
  }

  const stats = pet?.stats

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      {/* 标题 + 交互提示 */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold bg-neon-grad bg-clip-text text-transparent">{t('survival.title')}</h1>
          <p className="text-xs text-slate-400 mt-1">{t('survival.subtitle')}</p>
        </div>
        <p className="tag border-neon-cyan/40 text-neon-cyan">👆 {t('survival.hint')}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* 左:Canvas 房间(约 3:2) */}
        <div className="lg:col-span-2 relative">
          <SurvivalRoom
            equipped={equipped}
            petName={didName}
            hasPet={!!pet}
            status={pet?.status ?? 'alive'}
            cooldowns={pet?.cooldowns ?? { feed: 0, clean: 0, work: 0 }}
            busy={busy}
            outcome={outcome}
            labels={roomLabels}
            onAction={onAction}
            onDormantClick={onDormantClick}
            onBusyClick={onBusyClick}
          />
          {busy && (
            <div className="absolute top-3 left-3 tag border-neon-purple/60 text-neon-purple bg-ink/70 animate-pulse">
              ⏳ {t('survival.action.acting')}
            </div>
          )}

          {/* 动作确认弹窗:画布上方居中,取消可返回 */}
          {pending && pending.kind !== 'revive' && (
            <div className="absolute inset-0 z-20 grid place-items-center bg-black/55 backdrop-blur-[2px] p-4">
              <div className="glass neon-border w-full max-w-xs p-5">
                {pending.kind === 'feed' ? (
                  <>
                    <h3 className="font-bold mb-2">🍖 {t('survival.feed.amountTitle')}</h3>
                    <p className="text-xs text-slate-400 leading-relaxed mb-3">{t('survival.feed.desc')}</p>
                    <div className="grid grid-cols-3 gap-2 mb-4">
                      {FEED_OPTIONS.map((a) => (
                        <button
                          key={a}
                          onClick={() => setFeedAmount(a)}
                          className={`rounded-xl border px-2 py-2 text-sm font-mono transition ${
                            feedAmount === a
                              ? 'border-neon-purple text-white bg-neon-purple/20 shadow-neon-purple'
                              : 'border-white/15 text-slate-300 hover:border-neon-purple/60'
                          }`}
                        >
                          {a} NEAR
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button onClick={cancelPending} className="btn-ghost flex-1">{t('survival.modal.cancel')}</button>
                      <button onClick={() => void executeFeed()} className="btn-primary flex-1">
                        {t('survival.feed.confirm')}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h3 className="font-bold mb-2">
                      {pending.kind === 'clean' ? '🧹' : '💻'} {t(`survival.${pending.kind}.title`)}
                    </h3>
                    <p className="text-xs text-slate-400 leading-relaxed mb-4">{t(`survival.${pending.kind}.desc`)}</p>
                    <div className="flex gap-2">
                      <button onClick={cancelPending} className="btn-ghost flex-1">{t('survival.modal.cancel')}</button>
                      <button
                        onClick={() => void (pending.kind === 'clean' ? executeClean() : executeAction(pending.kind))}
                        className="btn-primary flex-1"
                      >
                        {t(`survival.${pending.kind}.confirm`)}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 右:状态面板 / 领养卡 + 动作日志 */}
        <aside className="space-y-4">
          {!pet && petChecked ? (
            /* 未领养:领养卡 */
            <div className="glass neon-border p-5">
              <h2 className="font-bold mb-1">🥚 {t('survival.adopt.title')}</h2>
              <p className="text-xs text-slate-400 leading-relaxed mb-4">{t('survival.adopt.desc')}</p>
              <p className="text-xs text-slate-300 mb-2">{t('survival.adopt.principal')}</p>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {PRINCIPAL_OPTIONS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setPrincipal(p)}
                    className={`rounded-xl border px-2 py-2 text-sm font-mono transition ${
                      principal === p
                        ? 'border-neon-purple text-white bg-neon-purple/20 shadow-neon-purple'
                        : 'border-white/15 text-slate-300 hover:border-neon-purple/60'
                    }`}
                  >
                    {p} NEAR
                  </button>
                ))}
              </div>
              <button onClick={onAdopt} disabled={!!adoptStage} className="btn-primary w-full">
                {adoptStage ? t(`survival.adopt.step.${adoptStage}`) : t('survival.adopt.go')}
              </button>
            </div>
          ) : (
            /* 状态面板 */
            <div className="glass p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-bold">{t('survival.panel.status')}</h2>
                {pet && <span className={`tag ${PET_STATUS_CLS[pet.status]}`}>{t(`survival.status.${pet.status}`)}</span>}
              </div>

              {/* 四条状态条 */}
              {stats ? (
                <div className="space-y-3">
                  {STAT_BARS.map(({ key, cls }) => {
                    const v = Math.max(0, Math.min(100, Number(stats[key]) || 0))
                    return (
                      <div key={key}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-slate-300">{t(`survival.panel.${key}`)}</span>
                          <span className="text-slate-400 font-mono">{v.toFixed(0)}</span>
                        </div>
                        <div className="h-2.5 rounded-full bg-white/10 overflow-hidden">
                          <div className={`h-full rounded-full bg-gradient-to-r ${cls} transition-all duration-700`} style={{ width: `${v}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="text-xs text-slate-500 py-2">{petChecked ? t('survival.panel.noPet') : t('survival.loading')}</p>
              )}

              {pet?.status === 'weak' && (
                <p className="text-xs text-amber-300/90">💊 {t('survival.panel.weakTip')}</p>
              )}
              {pet?.status === 'dormant' && (
                <p className="text-xs text-sky-300/90">💤 {t('survival.panel.dormantTip')}</p>
              )}

              {pet && (
                <>
                  <div className="border-t border-white/10 pt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <div>
                      <p className="text-slate-500">{t('survival.panel.credits')}</p>
                      <p className="text-neon-cyan font-mono">${Number(pet.credits.balanceUsd).toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">{t('survival.panel.creditsBurned')}</p>
                      <p className="text-slate-400 font-mono">${Number(pet.credits.burnedUsd).toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">{t('survival.panel.principal')}</p>
                      <p className="text-slate-200 font-mono">Ⓝ {formatNear(pet.principalYocto)}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">{t('survival.panel.earnings')}</p>
                      <p className="text-emerald-300 font-mono">Ⓝ {formatNear(pet.earningsYocto)}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">{t('survival.panel.yield')}</p>
                      <p className="text-emerald-300 font-mono">Ⓝ {formatNear(pet.yieldYocto)}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">{t('survival.panel.deaths')}</p>
                      <p className="text-slate-200 font-mono">{pet.deathCount}</p>
                    </div>
                  </div>
                  {positions.length > 0 && (
                    <div className="border-t border-white/10 pt-3">
                      <p className="text-slate-500 text-xs mb-2">{t('survival.positions.title')}</p>
                      <ul className="space-y-1.5">
                        {positions.map((p, i) => (
                          <li key={`${p.kind}-${i}`} className="flex items-center gap-2 text-xs" title={p.note}>
                            <span>{POSITION_ICON[p.kind] ?? '💰'}</span>
                            <span className="text-slate-300">
                              {POSITION_ICON[p.kind] != null ? t(`survival.positions.${p.kind}`) : p.kind}
                            </span>
                            <span className="ml-auto text-slate-200 font-mono">
                              {fmtAmount(p.amountAtomic, p.token)} {p.token}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {pet.stakeTx && (
                    <a
                      href={explorerTx(pet.stakeTx)}
                      target="_blank"
                      rel="noreferrer"
                      className="block text-[11px] text-slate-500 hover:text-neon-cyan transition truncate"
                    >
                      🔗 {t('survival.panel.stakeTx')}
                    </a>
                  )}
                  {pet.status === 'dead' && (
                    <button onClick={() => setPending({ kind: 'revive' })} disabled={reviving} className="btn-primary w-full !py-2">
                      {reviving ? t('survival.panel.reviving') : `💫 ${t('survival.panel.revive')}`}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* 动作日志 */}
          <div className="glass p-5">
            <h2 className="font-bold mb-3">📜 {t('survival.log.title')}</h2>
            {actions.length === 0 ? (
              <p className="text-xs text-slate-500 py-2">{t('survival.log.empty')}</p>
            ) : (
              <ul className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {actions.map((a) => (
                  <li key={a.id} className="flex items-start gap-2 text-xs">
                    <span className="mt-0.5">{KIND_ICON[a.kind]}</span>
                    <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[a.status]}`} title={t(`survival.log.${a.status}`)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-slate-200">{t(`survival.action.${a.kind}`)}</span>
                        <span className="text-slate-500">
                          · ${Number(a.creditCostUsd).toFixed(4)}
                          {a.pnlYocto != null && (
                            <span className={Number(a.pnlYocto) >= 0 ? ' text-emerald-300' : ' text-red-300'}>
                              {' '}(Ⓝ {formatNear(a.pnlYocto)})
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="text-slate-500 flex items-center gap-2">
                        <span>{fmtTime(a.createdAt)}</span>
                        {a.txHash && (
                          <a href={explorerTx(a.txHash)} target="_blank" rel="noreferrer" className="text-neon-cyan/80 hover:text-neon-cyan truncate">
                            {a.txHash.slice(0, 10)}…
                          </a>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      {/* 排行榜(可折叠) */}
      <div className="glass mt-4">
        <button onClick={() => setBoardOpen(!boardOpen)} className="w-full flex items-center justify-between px-5 py-3 text-sm font-bold">
          <span>🏆 {t('survival.board.title')}</span>
          <span className="text-slate-400">{boardOpen ? '▾' : '▸'}</span>
        </button>
        {boardOpen && (
          <div className="overflow-x-auto px-2 pb-3">
            {board.length === 0 ? (
              <p className="text-xs text-slate-500 px-3 py-2">{t('survival.board.empty')}</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 text-left">
                    <th className="px-3 py-2 font-medium">#</th>
                    <th className="px-3 py-2 font-medium">{t('survival.board.name')}</th>
                    <th className="px-3 py-2 font-medium">{t('survival.board.status')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('survival.board.earnings')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('survival.board.yield')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('survival.board.deaths')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('survival.board.age')}</th>
                  </tr>
                </thead>
                <tbody>
                  {board.map((e, i) => (
                    <tr key={e.tokenId} className={`border-t border-white/5 ${e.tokenId === tokenId ? 'bg-neon-purple/10 text-neon-cyan' : 'text-slate-300'}`}>
                      <td className="px-3 py-2 font-mono">{i + 1}</td>
                      <td className="px-3 py-2">
                        {e.name}
                        {e.tokenId === tokenId && <span className="tag border-neon-cyan/40 text-neon-cyan ml-2">{t('survival.board.me')}</span>}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`tag ${PET_STATUS_CLS[e.status]}`}>{t(`survival.status.${e.status}`)}</span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">Ⓝ {formatNear(e.earningsYocto)}</td>
                      <td className="px-3 py-2 text-right font-mono">Ⓝ {formatNear(e.yieldYocto)}</td>
                      <td className="px-3 py-2 text-right font-mono">{e.deathCount}</td>
                      <td className="px-3 py-2 text-right font-mono">{ageLabel(e.ageHours)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* 复活确认弹窗 */}
      {pending?.kind === 'revive' && (
        <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm grid place-items-center p-4">
          <div className="glass neon-border w-full max-w-xs p-5">
            <h3 className="font-bold mb-2">💫 {t('survival.revive.title')}</h3>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">{t('survival.revive.desc')}</p>
            <div className="flex gap-2">
              <button onClick={() => setPending(null)} disabled={reviving} className="btn-ghost flex-1">
                {t('survival.modal.cancel')}
              </button>
              <button onClick={() => void onRevive()} disabled={reviving} className="btn-primary flex-1">
                {reviving ? t('survival.panel.reviving') : t('survival.revive.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
