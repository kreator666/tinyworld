import { useCallback, useEffect, useState } from 'react'
import { t, useI18n } from '../i18n'
import { useAppStore } from '../store/appStore'
import { useChainConfig } from '../store/chainConfigStore'
import { fetchMintedAgents, type MintedAgent } from '../lib/chainDispatch'
import { sendTransactions } from '../lib/chainDispatch'
import {
  arenaFreeze,
  arenaFreezeConfirm,
  arenaWithdraw,
  arenaWithdrawConfirm,
  getArenaTrades,
  type ArenaTrade,
  arenaRegister,
  arenaRegisterConfirm,
  getArenaSeason,
  getArenaSnapshots,
  getMyArenaAccount,
  listArenaSeasons,
  saveArenaPlaybook,
  type ArenaSeason,
  type LeaderboardEntry,
  type MyArenaAccount,
  getArenaDecisions,
  type ArenaDecision,
  getArenaExecutions,
  type ArenaExecution,
} from '../lib/arenaApi'

// ============================================================
// 竞技场页面(P5):赛季列表 / 排行榜(荣誉榜)/ 报名 / 策略配置 / 净值曲线 / 紧急停止
// 交互链路对齐后端:报名与冻结 = 后端组装 unsigned tx → 钱包逐笔签名 → 回执确认回写
// ============================================================

const RISK_PROFILES = [
  { key: 'conservative' },
  { key: 'balanced' },
  { key: 'aggressive' },
  { key: 'custom' },
] as const

const STATUS_CLS: Record<string, string> = {
  created: 'bg-slate-500/20 text-slate-400',
  open: 'bg-emerald-500/20 text-emerald-300',
  active: 'bg-sky-500/20 text-sky-300',
  settling: 'bg-amber-500/20 text-amber-300',
  settled: 'bg-slate-500/20 text-slate-400',
}

/** 词典缺失对应 key 时回退原始值(如后端新增的 action/tool 类型) */
const dictLabel = (ns: string, k: string) => {
  const v = t(`${ns}.${k}`)
  return v === `${ns}.${k}` ? k : v
}
const actionLabel = (a: string) => dictLabel('arena.action', a)
const toolLabel = (id: string) => dictLabel('arena.tool', id)
const strategyLabel = (s: string) => dictLabel('arena.strategy', s)

const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`

/** 净值曲线:轻量 SVG 折线(无第三方依赖) */
function NavCurve({ points }: { points: { t: string; v: number }[] }) {
  const { t } = useI18n()
  if (points.length < 2) return <p className="text-xs text-slate-500 py-6 text-center">{t('arena.nav.insufficient')}</p>
  const W = 560
  const H = 140
  const vals = points.map((p) => p.v)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${((i / (points.length - 1)) * W).toFixed(1)},${(H - ((p.v - min) / span) * (H - 16) - 8).toFixed(1)}`)
    .join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-36">
      <path d={path} fill="none" stroke="#38bdf8" strokeWidth="2" />
      <text x="4" y="12" className="fill-slate-400" fontSize="10">{t('arena.nav.high', { v: max.toFixed(2) })}</text>
      <text x="4" y={H - 2} className="fill-slate-400" fontSize="10">{t('arena.nav.low', { v: min.toFixed(2) })}</text>
    </svg>
  )
}

export default function ArenaPage() {
  const { t } = useI18n()
  const { connected, address, login, showToast } = useAppStore()
  const { active } = useChainConfig()
  const [seasons, setSeasons] = useState<ArenaSeason[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [season, setSeason] = useState<ArenaSeason | null>(null)
  const [myAgents, setMyAgents] = useState<MintedAgent[]>([])
  const [agentTokenId, setAgentTokenId] = useState<number>(0)
  const [mine, setMine] = useState<MyArenaAccount | null>(null)
  const [navPoints, setNavPoints] = useState<{ t: string; v: number }[]>([])
  const [trades, setTrades] = useState<ArenaTrade[]>([])
  const [decisions, setDecisions] = useState<ArenaDecision[]>([])
  const [executions, setExecutions] = useState<ArenaExecution[]>([])
  const [busy, setBusy] = useState(false)
  const [playbookDraft, setPlaybookDraft] = useState<Record<string, unknown> | null>(null)
  const isEvm = active.family === 'evm'

  const reloadSeasons = useCallback(async () => {
    try {
      const r = await listArenaSeasons()
      setSeasons(r.seasons)
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('arena.toast.seasonsFail'))
    }
  }, [showToast])

  const reloadDetail = useCallback(async (id: string, tokenId: number) => {
    try {
      const d = await getArenaSeason(id)
      setSeason(d.season)
      setLeaderboard(d.leaderboard)
      if (tokenId > 0) {
        try {
          const m = await getMyArenaAccount(id, tokenId)
          setMine(m)
          setPlaybookDraft(m.playbook ?? defaultPlaybook())
          const snaps = await getArenaSnapshots(id, tokenId)
          setNavPoints(snaps.snapshots.map((s) => ({ t: s.created_at, v: Number(s.nav_usd) })))
          try {
            const t = await getArenaTrades(id, tokenId)
            setTrades(t.trades)
          } catch {
            setTrades([])
          }
          try {
            const d = await getArenaDecisions(id, tokenId, 20)
            setDecisions(d.decisions)
          } catch {
            setDecisions([])
          }
          try {
            const e = await getArenaExecutions(id, tokenId, undefined, 100)
            setExecutions(e.executions)
          } catch {
            setExecutions([])
          }
        } catch {
          setMine(null)
          setPlaybookDraft(null)
        }
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('arena.toast.detailFail'))
    }
  }, [showToast])

  useEffect(() => {
    reloadSeasons()
  }, [reloadSeasons])

  useEffect(() => {
    if (!connected || !isEvm || !address) return
    fetchMintedAgents()
      .then((agents) => {
        // 只列出当前连接钱包的 agent(fetchMintedAgents 返回全量已铸造)
        const mine = agents.filter((a) => a.owner.toLowerCase() === address.toLowerCase())
        setMyAgents(mine)
        setAgentTokenId((id) => (mine.some((a) => a.tokenId === id) ? id : (mine[0]?.tokenId ?? 0)))
      })
      .catch(() => showToast(t('arena.toast.myAgentsFail')))
  }, [connected, isEvm, address, showToast])

  useEffect(() => {
    if (selected) reloadDetail(selected, agentTokenId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, agentTokenId])

  const defaultPlaybook = (): Record<string, unknown> => ({
    riskProfile: 'balanced',
    allocation: { fixed_yield: 50, spot: 30, perp: 20 },
    strategies: [
      { type: 'fixed_yield', protocol: 'aave', asset: 'USDC', autoCompound: true },
      { type: 'spot', universe: ['AVAX', 'USDC'], rebalanceMode: 'threshold' },
      { type: 'perp', directionBias: 'neutral', maxLeverage: 3 },
    ],
    guardrails: {},
  })

  const onRegister = async () => {
    if (!selected || agentTokenId === 0 || !address) return
    setBusy(true)
    try {
      const r = await arenaRegister(selected, agentTokenId)
      showToast(t('arena.toast.registerSign'))
      const txHashes = await sendTransactions(address, r.txs, { tokenId: agentTokenId })
      const registerTx = txHashes[txHashes.length - 1]
      showToast(t('arena.toast.broadcast'))
      await arenaRegisterConfirm(selected, agentTokenId, registerTx)
      showToast(t('arena.toast.registerOk'))
      reloadDetail(selected, agentTokenId)
      reloadSeasons()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('arena.toast.registerFail'))
    } finally {
      setBusy(false)
    }
  }

  const onSavePlaybook = async () => {
    if (!selected || agentTokenId === 0 || !playbookDraft) return
    setBusy(true)
    try {
      const r = await saveArenaPlaybook(selected, agentTokenId, playbookDraft)
      showToast(t('arena.toast.playbookSaved', { version: r.version }))
      reloadDetail(selected, agentTokenId)
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('arena.toast.saveFail'))
    } finally {
      setBusy(false)
    }
  }

  const onFreeze = async () => {
    if (!selected || agentTokenId === 0 || !address) return
    if (!window.confirm(t('arena.confirm.freeze'))) return
    setBusy(true)
    try {
      const r = await arenaFreeze(selected, agentTokenId)
      showToast(t('arena.toast.freezeSign'))
      const txHashes = await sendTransactions(address, r.txs, { tokenId: agentTokenId })
      await arenaFreezeConfirm(selected, agentTokenId, txHashes[txHashes.length - 1])
      showToast(t('arena.toast.frozen'))
      reloadDetail(selected, agentTokenId)
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('arena.toast.freezeFail'))
    } finally {
      setBusy(false)
    }
  }

  const onWithdraw = async () => {
    if (!selected || agentTokenId === 0 || !address) return
    if (!window.confirm(t('arena.confirm.withdraw'))) return
    setBusy(true)
    try {
      const r = await arenaWithdraw(selected, agentTokenId)
      showToast(t('arena.toast.withdrawSign'))
      const txHashes = await sendTransactions(address, r.txs, { tokenId: agentTokenId })
      showToast(t('arena.toast.broadcast'))
      await arenaWithdrawConfirm(selected, agentTokenId, txHashes[txHashes.length - 1])
      showToast(t('arena.toast.withdrawOk'))
      reloadDetail(selected, agentTokenId)
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('arena.toast.withdrawFail'))
    } finally {
      setBusy(false)
    }
  }

  const setPb = (patch: Record<string, unknown>) => setPlaybookDraft((d) => ({ ...(d ?? {}), ...patch }))
  const alloc = (playbookDraft?.allocation ?? {}) as Record<string, number>
  const guardrails = (playbookDraft?.guardrails ?? {}) as Record<string, number>

  const statusOf = (s: ArenaSeason) => {
    const cls = STATUS_CLS[s.status] ?? STATUS_CLS.created
    const text = t(`arena.status.${s.status}`)
    return { cls, text: text === `arena.status.${s.status}` ? t('arena.status.created') : text }
  }

  if (!isEvm) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-6">
        <h2 className="text-2xl font-bold mb-1">{t('arena.title')}</h2>
        <p className="text-sm text-slate-400">{t('arena.evmOnly')}</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h2 className="text-2xl font-bold mb-1">{t('arena.title')}</h2>
      <p className="text-sm text-slate-400 mb-5">{t('arena.subtitle')}</p>

      {/* 赛季列表 */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        {seasons.length === 0 && (
          <div className="glass p-8 text-center text-slate-500 sm:col-span-2 lg:col-span-3">{t('arena.emptySeasons')}</div>
        )}
        {seasons.map((s) => {
          const st = statusOf(s)
          return (
            <button
              key={s.id}
              onClick={() => setSelected(s.id)}
              className={`glass p-4 text-left transition hover:border-sky-400/50 ${selected === s.id ? 'border-sky-400/70' : ''}`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-slate-400">{s.chain_key}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${st.cls}`}>{st.text}</span>
              </div>
              <div className="text-lg font-bold mb-1">{(s.config as { title?: string }).title ?? t('arena.seasonTitle')}</div>
              <div className="text-xs text-slate-400">
                {fmtTime(s.start_ts)} ~ {fmtTime(s.end_ts)}
              </div>
              <div className="text-xs text-slate-300 mt-2">
                {t('arena.seasonMeta', { p: `$${Number(s.principal_usd).toFixed(0)}`, f: Number(s.fuel_usd).toFixed(0), m: s.config.llmModel ?? '-' })}
              </div>
            </button>
          )
        })}
      </div>

      {/* 赛季详情 */}
      {selected && season && (
        <div className="grid lg:grid-cols-[1fr_360px] gap-6">
          <div className="space-y-6">
            {/* 排行榜 */}
            <section className="glass p-5">
              <h3 className="font-bold mb-3">{t('arena.board.title')}</h3>
              {leaderboard.length === 0 ? (
                <p className="text-sm text-slate-500 py-4 text-center">{t('arena.board.empty')}</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-slate-400 text-xs border-b border-white/10">
                      <th className="text-left py-2">#</th>
                      <th className="text-left">{t('arena.board.colAgent')}</th>
                      <th className="text-right">{t('arena.board.colNav')}</th>
                      <th className="text-right">{t('arena.board.colStatus')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.map((e, i) => {
                      const principal = Number(season.principal_usd)
                      const nav = Number(e.nav_usd)
                      const pnlPct = principal > 0 ? ((nav - principal) / principal) * 100 : 0
                      return (
                        <tr key={e.token_id} className="border-b border-white/5">
                          <td className="py-2 text-slate-400">{i + 1}</td>
                          <td>
                            {e.name ?? `Agent #${e.token_id}`}
                            <span className="block text-[10px] text-slate-500">{short(e.account_address)}</span>
                          </td>
                          <td className="text-right">
                            {nav.toFixed(2)}
                            <span className={`block text-[10px] ${pnlPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                            </span>
                          </td>
                          <td className="text-right">
                            {e.phase === 'frozen' && <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-300">{t('arena.board.phaseFrozen')}</span>}
                            {e.phase === 'settled' && <span className="text-xs px-2 py-0.5 rounded bg-slate-500/20 text-slate-400">{t('arena.board.phaseSettled')}</span>}
                            {e.phase === 'active' && <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">{t('arena.board.phaseActive')}</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </section>

            {/* 我的账户 / 报名 */}
            <section className="glass p-5">
              <h3 className="font-bold mb-3">{t('arena.my.title')}</h3>
              {!connected ? (
                <p className="text-sm text-slate-500 py-4 text-center">{t('arena.my.connectToRegister')}</p>
              ) : mine ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div className="bg-white/5 rounded p-3">
                      <div className="text-xs text-slate-400 mb-1">{t('arena.my.statNav')}</div>
                      <div className="font-bold">${Number(mine.account.nav_usd ?? season.principal_usd).toFixed(2)}</div>
                    </div>
                    <div className="bg-white/5 rounded p-3">
                      <div className="text-xs text-slate-400 mb-1">{t('arena.my.statFuel')}</div>
                      <div className="font-bold">${mine.fuel ? Number(mine.fuel.balance_usd).toFixed(4) : '-'}</div>
                      {mine.fuel?.decision_halted && <div className="text-[10px] text-amber-300 mt-1">{t('arena.my.decisionHalted')}</div>}
                    </div>
                    <div className="bg-white/5 rounded p-3">
                      <div className="text-xs text-slate-400 mb-1">{t('arena.my.statVersion')}</div>
                      <div className="font-bold">v{mine.playbookVersion}</div>
                    </div>
                  </div>
                  <NavCurve points={navPoints} />
                  {/* 动作记录:谁(agent#tokenId)、哪个赛季(当前)、做了什么 */}
                  <div>
                    <div className="text-xs text-slate-400 mb-2">{t('arena.my.actionLog', { tokenId: agentTokenId, season: selected })}</div>
                    {trades.length === 0 ? (
                      <p className="text-[10px] text-slate-600 text-center py-2">{t('arena.my.actionEmpty')}</p>
                    ) : (
                      <div className="max-h-48 overflow-y-auto space-y-1">
                        {trades.map((trade) => {
                          const acted = (trade.payload?.actions as { action: string; ok: boolean; detail: string }[] | undefined)?.filter((a) => a.ok)
                          const rejected = (trade.payload?.actions as { action: string; ok: boolean; detail: string }[] | undefined)?.filter((a) => !a.ok)
                          const plan = trade.payload?.plan as ArenaDecision['plan'] | undefined
                          const summary = (trade.payload?.summary as string) || (trade.payload?.reason as string) || plan?.reasoning
                          return (
                            <div key={trade.id} className="text-[10px] bg-white/5 rounded px-2 py-1.5">
                              <div className="flex items-center justify-between">
                                <span className="text-slate-300">
                                  <span className="text-sky-300">{strategyLabel(trade.strategy_type)}</span>
                                  {' / '}
                                  {actionLabel(trade.action)}
                                  {acted && acted.length > 0 && <span className="ml-1.5 text-emerald-400">✓ {acted.map((a) => actionLabel(a.action)).join(', ')}</span>}
                                  {rejected && rejected.length > 0 && <span className="ml-1.5 text-rose-400">{t('arena.my.rejectedCount', { count: rejected.length })}</span>}
                                  {plan?.scores && (
                                    <span className="ml-1.5 text-slate-400">
                                      {t('arena.my.scoresInline', { ret: plan.scores.expectedReturn, risk: plan.scores.risk, survival: plan.scores.survival })}
                                    </span>
                                  )}
                                </span>
                                <span className="text-right shrink-0">
                                  {trade.tx_hash ? (
                                    <a href={`${active.explorer}/tx/${trade.tx_hash}`} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline block">{trade.tx_hash.slice(0, 8)}…</a>
                                  ) : (
                                    <span className="text-slate-600">-</span>
                                  )}
                                  <span className="block text-slate-500">{new Date(trade.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                </span>
                              </div>
                              {summary && (
                                <div className="mt-1 text-slate-400 break-words leading-relaxed" title={summary}>
                                  {summary}
                                </div>
                              )}
                              {rejected && rejected.length > 0 && (
                                <ul className="mt-1 space-y-0.5">
                                  {rejected.map((r, i) => (
                                    <li key={i} className="text-rose-300/80 break-words">
                                      · {actionLabel(r.action)}: {r.detail}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* 思考与执行记录(P4+):展示 LLM 思考过程与执行结果 */}
                  <div>
                    <div className="text-xs text-slate-400 mb-2">{t('arena.my.thinkingTitle')}</div>
                    {decisions.length === 0 ? (
                      <p className="text-[10px] text-slate-600 text-center py-2">{t('arena.my.thinkingEmpty')}</p>
                    ) : (
                      <div className="max-h-64 overflow-y-auto space-y-2">
                        {decisions.map((d) => {
                          const plan = d.plan
                          const decisionExecutions = executions.filter((e) => e.decision_id === d.id)
                          return (
                            <details key={d.id} className="text-[10px] bg-white/5 rounded px-2 py-1.5 group">
                              <summary className="cursor-pointer list-none flex items-center justify-between text-slate-300">
                                <span>
                                  <span className="text-sky-300">{new Date(d.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                  <span className="ml-2">{(plan.intendedActions?.length ?? 0) === 0 ? t('arena.my.hold') : t('arena.my.plannedCount', { count: plan.intendedActions?.length ?? 0 })}</span>
                                  {plan.scores && (
                                    <span className="ml-2 text-slate-400">
                                      {t('arena.my.scores', { ret: plan.scores.expectedReturn, risk: plan.scores.risk, survival: plan.scores.survival })}
                                    </span>
                                  )}
                                </span>
                                <span className="text-slate-500">{d.model} · ${Number(d.cost_usd || 0).toFixed(6)}</span>
                              </summary>
                              {plan.reasoning && (
                                <div className="mt-1.5 text-slate-400 break-words leading-relaxed">
                                  <span className="text-slate-500">{t('arena.my.thinking')}</span>{plan.reasoning}
                                </div>
                              )}
                              {plan.riskAssessment && (
                                <div className="mt-1 text-slate-400 break-words leading-relaxed">
                                  <span className="text-slate-500">{t('arena.my.riskAssessment')}</span>{plan.riskAssessment}
                                </div>
                              )}
                              {plan.survivalCheck && (
                                <div className="mt-1 text-slate-400 break-words leading-relaxed">
                                  <span className="text-slate-500">{t('arena.my.survivalCheck')}</span>{plan.survivalCheck}
                                </div>
                              )}
                              {plan.intendedActions && plan.intendedActions.length > 0 && (
                                <div className="mt-1.5">
                                  <div className="text-slate-500 mb-0.5">{t('arena.my.plannedActions')}</div>
                                  <ul className="space-y-0.5">
                                    {plan.intendedActions.map((a, i) => (
                                      <li key={i} className="text-slate-400 break-words">
                                        · {toolLabel(a.toolId)}{a.reason ? ` (${a.reason})` : ''}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {decisionExecutions.length > 0 && (
                                <div className="mt-1.5">
                                  <div className="text-slate-500 mb-0.5">{t('arena.my.execResults')}</div>
                                  <ul className="space-y-0.5">
                                    {decisionExecutions.map((e) => (
                                      <li key={e.id} className="break-words">
                                        <span className={e.status === 'success' ? 'text-emerald-400' : e.status === 'skipped' ? 'text-amber-400' : 'text-rose-400'}>
                                          {e.status === 'success' ? '✓' : e.status === 'skipped' ? '⊘' : '✗'} {toolLabel(e.tool_id)}
                                        </span>
                                        {e.error && <span className="text-rose-300/80 ml-1">: {e.error}</span>}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </details>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  {mine.account.phase === 'active' && (
                    <button onClick={onFreeze} disabled={busy} className="w-full py-2 rounded bg-rose-500/80 hover:bg-rose-500 text-white text-sm font-bold disabled:opacity-50">
                      {t('arena.my.freezeBtn')}
                    </button>
                  )}
                  {mine.account.phase === 'frozen' && (
                    <p className="text-xs text-slate-400 text-center">{t('arena.my.frozenHint')}</p>
                  )}
                  {mine.account.phase === 'settled' && (
                    <button onClick={onWithdraw} disabled={busy} className="w-full py-2 rounded bg-emerald-500/80 hover:bg-emerald-500 text-white text-sm font-bold disabled:opacity-50">
                      {t('arena.my.withdrawBtn')}
                    </button>
                  )}
                </div>
              ) : season.status !== 'settled' && season.end_ts * 1000 > Date.now() ? (
                <div className="space-y-3">
                  <label className="block text-xs text-slate-400">
                    {t('arena.my.selectAgent')}
                    <select
                      value={agentTokenId}
                      onChange={(e) => setAgentTokenId(Number(e.target.value))}
                      className="mt-1 w-full bg-white/10 rounded px-3 py-2 text-sm"
                    >
                      {myAgents.map((a) => (
                        <option key={a.tokenId} value={a.tokenId} className="bg-slate-800">
                          {a.name} #{a.tokenId}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="text-xs text-slate-400">
                    {t('arena.my.registerHintBefore')}<b>${Number(season.principal_usd).toFixed(0)}U</b>{t('arena.my.registerHintMid')}<b>${Number(season.fuel_usd).toFixed(0)}U</b>{t('arena.my.registerHintAfter')}
                  </p>
                  <button onClick={onRegister} disabled={busy || myAgents.length === 0} className="w-full py-2 rounded bg-sky-500/80 hover:bg-sky-500 text-white text-sm font-bold disabled:opacity-50">
                    {busy ? t('arena.my.busy') : t('arena.my.registerBtn')}
                  </button>
                </div>
              ) : (
                <p className="text-sm text-slate-500 py-4 text-center">{t('arena.my.closedHint')}</p>
              )}
            </section>
          </div>

          {/* 策略配置面板 */}
          <aside className="glass p-5 h-fit">
            <h3 className="font-bold mb-3">{t('arena.playbook.title')}</h3>
            {!mine ? (
              <p className="text-sm text-slate-500 py-4 text-center">{t('arena.playbook.needRegister')}</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="text-xs text-slate-400 mb-2">{t('arena.playbook.riskProfile')}</div>
                  <div className="grid grid-cols-4 gap-1">
                    {RISK_PROFILES.map((r) => (
                      <button
                        key={r.key}
                        onClick={() => setPb({ riskProfile: r.key })}
                        className={`py-1.5 rounded text-xs ${playbookDraft?.riskProfile === r.key ? 'bg-sky-500/80 text-white' : 'bg-white/10 text-slate-300 hover:bg-white/20'}`}
                      >
                        {t(`arena.risk.${r.key}`)}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-400 mb-2">{t('arena.playbook.allocation')}</div>
                  {(['fixed_yield', 'spot', 'perp'] as const).map((k) => (
                    <label key={k} className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-slate-300">{t(`arena.alloc.${k}`)}</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={alloc[k] ?? 0}
                        onChange={(e) => setPb({ allocation: { ...alloc, [k]: Number(e.target.value) } })}
                        className="w-20 bg-white/10 rounded px-2 py-1 text-right"
                      />
                    </label>
                  ))}
                </div>
                <div>
                  <div className="text-xs text-slate-400 mb-2">{t('arena.playbook.guardrails')}</div>
                  {(['maxDailyLossPct', 'maxDrawdownPct', 'minCashBufferPct'] as const).map((k) => (
                    <label key={k} className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-slate-300">{t(`arena.guardrail.${k}`)}</span>
                      <input
                        type="number"
                        min={0}
                        value={guardrails[k] ?? ''}
                        placeholder={t('arena.playbook.placeholder')}
                        onChange={(e) =>
                          setPb({ guardrails: { ...guardrails, [k]: e.target.value === '' ? undefined : Number(e.target.value) } })
                        }
                        className="w-20 bg-white/10 rounded px-2 py-1 text-right"
                      />
                    </label>
                  ))}
                </div>
                <details className="text-xs">
                  <summary className="text-slate-400 cursor-pointer hover:text-slate-200">{t('arena.playbook.advanced')}</summary>
                  <textarea
                    value={JSON.stringify(playbookDraft, null, 2)}
                    onChange={(e) => {
                      try {
                        setPlaybookDraft(JSON.parse(e.target.value))
                      } catch {
                        /* 输入中,不合法 JSON 时保留草稿不动 */
                      }
                    }}
                    rows={10}
                    className="mt-2 w-full bg-white/5 rounded p-2 font-mono text-[10px]"
                  />
                </details>
                <button onClick={onSavePlaybook} disabled={busy} className="w-full py-2 rounded bg-emerald-500/80 hover:bg-emerald-500 text-white text-sm font-bold disabled:opacity-50">
                  {t('arena.playbook.saveBtn')}
                </button>
                <p className="text-[10px] text-slate-500">{t('arena.playbook.fuelNote')}</p>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}
