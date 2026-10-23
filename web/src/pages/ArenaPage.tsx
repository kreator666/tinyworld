import { useCallback, useEffect, useMemo, useState } from 'react'
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
} from '../lib/arenaApi'

// ============================================================
// 竞技场页面(P5):赛季列表 / 排行榜(荣誉榜)/ 报名 / 策略配置 / 净值曲线 / 紧急停止
// 交互链路对齐后端:报名与冻结 = 后端组装 unsigned tx → 钱包逐笔签名 → 回执确认回写
// ============================================================

const RISK_PROFILES = [
  { key: 'conservative', label: '保守' },
  { key: 'balanced', label: '均衡' },
  { key: 'aggressive', label: '激进' },
  { key: 'custom', label: '自定义' },
] as const

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  created: { text: '待部署', cls: 'bg-slate-500/20 text-slate-400' },
  open: { text: '报名中', cls: 'bg-emerald-500/20 text-emerald-300' },
  active: { text: '赛季中', cls: 'bg-sky-500/20 text-sky-300' },
  settling: { text: '待结算', cls: 'bg-amber-500/20 text-amber-300' },
  settled: { text: '已结束', cls: 'bg-slate-500/20 text-slate-400' },
}

const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`

/** 净值曲线:轻量 SVG 折线(无第三方依赖) */
function NavCurve({ points }: { points: { t: string; v: number }[] }) {
  if (points.length < 2) return <p className="text-xs text-slate-500 py-6 text-center">快照不足,调度器运行后自动生成曲线</p>
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
      <text x="4" y="12" className="fill-slate-400" fontSize="10">高 {max.toFixed(2)}</text>
      <text x="4" y={H - 2} className="fill-slate-400" fontSize="10">低 {min.toFixed(2)}</text>
    </svg>
  )
}

export default function ArenaPage() {
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
  const [busy, setBusy] = useState(false)
  const [playbookDraft, setPlaybookDraft] = useState<Record<string, unknown> | null>(null)
  const isEvm = active.family === 'evm'

  const reloadSeasons = useCallback(async () => {
    try {
      const r = await listArenaSeasons()
      setSeasons(r.seasons)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '赛季列表加载失败')
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
        } catch {
          setMine(null)
          setPlaybookDraft(null)
        }
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '赛季详情加载失败')
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
      .catch(() => showToast('你的 Agent 列表加载失败'))
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
      showToast('请在钱包中确认两笔交易:授权 USDC + 报名注册')
      const txHashes = await sendTransactions(address, r.txs, { tokenId: agentTokenId })
      const registerTx = txHashes[txHashes.length - 1]
      showToast('交易已广播,等待链上确认…')
      await arenaRegisterConfirm(selected, agentTokenId, registerTx)
      showToast('报名成功!托管账户已创建,本金进入账户,燃料计入账本')
      reloadDetail(selected, agentTokenId)
      reloadSeasons()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '报名失败')
    } finally {
      setBusy(false)
    }
  }

  const onSavePlaybook = async () => {
    if (!selected || agentTokenId === 0 || !playbookDraft) return
    setBusy(true)
    try {
      const r = await saveArenaPlaybook(selected, agentTokenId, playbookDraft)
      showToast(`策略已保存(第 ${r.version} 版),下一轮决策生效`)
      reloadDetail(selected, agentTokenId)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const onFreeze = async () => {
    if (!selected || agentTokenId === 0 || !address) return
    if (!window.confirm('紧急停止将立即冻结托管账户:agent 无法继续执行任何交易,进入退赛结算流程(按当前净值结算后你可取回剩余资金)。确定继续?')) return
    setBusy(true)
    try {
      const r = await arenaFreeze(selected, agentTokenId)
      showToast('请在钱包中确认冻结交易')
      const txHashes = await sendTransactions(address, r.txs, { tokenId: agentTokenId })
      await arenaFreezeConfirm(selected, agentTokenId, txHashes[txHashes.length - 1])
      showToast('账户已冻结,等待平台结算')
      reloadDetail(selected, agentTokenId)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '冻结失败')
    } finally {
      setBusy(false)
    }
  }

  const onWithdraw = async () => {
    if (!selected || agentTokenId === 0 || !address) return
    if (!window.confirm('提取将把托管账户中的全部 USDC 和原生币转回你的钱包。确定继续?')) return
    setBusy(true)
    try {
      const r = await arenaWithdraw(selected, agentTokenId)
      showToast('请在钱包中确认两笔提取交易')
      const txHashes = await sendTransactions(address, r.txs, { tokenId: agentTokenId })
      showToast('交易已广播,等待链上确认…')
      await arenaWithdrawConfirm(selected, agentTokenId, txHashes[txHashes.length - 1])
      showToast('提取完成,资金已回到你的钱包')
      reloadDetail(selected, agentTokenId)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '提取失败')
    } finally {
      setBusy(false)
    }
  }

  const setPb = (patch: Record<string, unknown>) => setPlaybookDraft((d) => ({ ...(d ?? {}), ...patch }))
  const alloc = (playbookDraft?.allocation ?? {}) as Record<string, number>
  const guardrails = (playbookDraft?.guardrails ?? {}) as Record<string, number>

  const statusOf = useMemo(() => (s: ArenaSeason) => STATUS_LABEL[s.status] ?? STATUS_LABEL.created, [])

  if (!isEvm) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-6">
        <h2 className="text-2xl font-bold mb-1">竞技场</h2>
        <p className="text-sm text-slate-400">竞技场一期仅支持 EVM 链,请切换到 Avalanche 网络</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h2 className="text-2xl font-bold mb-1">竞技场</h2>
      <p className="text-sm text-slate-400 mb-5">agent 自主交易赛季:固定收益 / 现货 / 永续,到期按净值排名(荣誉榜)</p>

      {/* 赛季列表 */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        {seasons.length === 0 && (
          <div className="glass p-8 text-center text-slate-500 sm:col-span-2 lg:col-span-3">暂无赛季,等待管理员创建</div>
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
              <div className="text-lg font-bold mb-1">{(s.config as { title?: string }).title ?? '竞技赛季'}</div>
              <div className="text-xs text-slate-400">
                {fmtTime(s.start_ts)} ~ {fmtTime(s.end_ts)}
              </div>
              <div className="text-xs text-slate-300 mt-2">
                本金 ${Number(s.principal_usd).toFixed(0)} + 燃料 ${Number(s.fuel_usd).toFixed(0)}U · 模型 {s.config.llmModel ?? '-'}
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
              <h3 className="font-bold mb-3">排行榜(荣誉榜)</h3>
              {leaderboard.length === 0 ? (
                <p className="text-sm text-slate-500 py-4 text-center">尚无参赛者</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-slate-400 text-xs border-b border-white/10">
                      <th className="text-left py-2">#</th>
                      <th className="text-left">Agent</th>
                      <th className="text-right">净值(USDC)</th>
                      <th className="text-right">状态</th>
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
                            {e.phase === 'frozen' && <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-300">已退赛</span>}
                            {e.phase === 'settled' && <span className="text-xs px-2 py-0.5 rounded bg-slate-500/20 text-slate-400">已结算</span>}
                            {e.phase === 'active' && <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">比赛中</span>}
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
              <h3 className="font-bold mb-3">我的参赛</h3>
              {!connected ? (
                <p className="text-sm text-slate-500 py-4 text-center">连接钱包后报名参赛</p>
              ) : mine ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div className="bg-white/5 rounded p-3">
                      <div className="text-xs text-slate-400 mb-1">净值</div>
                      <div className="font-bold">${Number(mine.account.nav_usd ?? season.principal_usd).toFixed(2)}</div>
                    </div>
                    <div className="bg-white/5 rounded p-3">
                      <div className="text-xs text-slate-400 mb-1">燃料余额</div>
                      <div className="font-bold">${mine.fuel ? Number(mine.fuel.balance_usd).toFixed(4) : '-'}</div>
                      {mine.fuel?.decision_halted && <div className="text-[10px] text-amber-300 mt-1">决策停机(仓位仍计收益)</div>}
                    </div>
                    <div className="bg-white/5 rounded p-3">
                      <div className="text-xs text-slate-400 mb-1">策略版本</div>
                      <div className="font-bold">v{mine.playbookVersion}</div>
                    </div>
                  </div>
                  <NavCurve points={navPoints} />
                  {/* 动作记录:谁(agent#tokenId)、哪个赛季(当前)、做了什么 */}
                  <div>
                    <div className="text-xs text-slate-400 mb-2">动作记录(谁:Agent #{agentTokenId} · 赛季:{selected})</div>
                    {trades.length === 0 ? (
                      <p className="text-[10px] text-slate-600 text-center py-2">暂无动作 —— 调度器驱动决策后自动记录(固收/现货/永续每笔上链动作)</p>
                    ) : (
                      <div className="max-h-48 overflow-y-auto space-y-1">
                        {trades.map((t) => (
                          <div key={t.id} className="flex items-center justify-between text-[10px] bg-white/5 rounded px-2 py-1.5">
                            <span className="text-slate-300">
                              <span className="text-sky-300">{{ fixed_yield: '固收', spot: '现货', perp: '永续' }[t.strategy_type] ?? t.strategy_type}</span>
                              {' / '}
                              {{ supply: '存入', withdraw: '取出', swap: '兑换', gmx_order: '永续单' }[t.action] ?? t.action}
                              <span className="block text-slate-500 truncate max-w-[220px]">{t.payload?.reason as string}</span>
                            </span>
                            <span className="text-right shrink-0">
                              {t.tx_hash ? (
                                <a href={`${active.explorer}/tx/${t.tx_hash}`} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline block">{t.tx_hash.slice(0, 8)}…</a>
                              ) : (
                                <span className="text-slate-600">-</span>
                              )}
                              <span className="block text-slate-500">{new Date(t.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {mine.account.phase === 'active' && (
                    <button onClick={onFreeze} disabled={busy} className="w-full py-2 rounded bg-rose-500/80 hover:bg-rose-500 text-white text-sm font-bold disabled:opacity-50">
                      紧急停止并退赛
                    </button>
                  )}
                  {mine.account.phase === 'frozen' && (
                    <p className="text-xs text-slate-400 text-center">账户已冻结,等待平台结算;结算后可取回剩余资金</p>
                  )}
                  {mine.account.phase === 'settled' && (
                    <button onClick={onWithdraw} disabled={busy} className="w-full py-2 rounded bg-emerald-500/80 hover:bg-emerald-500 text-white text-sm font-bold disabled:opacity-50">
                      取回剩余资金(USDC + 原生币)
                    </button>
                  )}
                </div>
              ) : season.status !== 'settled' && season.end_ts * 1000 > Date.now() ? (
                <div className="space-y-3">
                  <label className="block text-xs text-slate-400">
                    选择参赛 Agent
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
                    报名需支付 <b>${Number(season.principal_usd).toFixed(0)}U</b> 本金(进入你的专属托管账户,只能与白名单协议交互)
                    + <b>${Number(season.fuel_usd).toFixed(0)}U</b> 燃料费(平台收取,用于 agent 的模型推理)
                  </p>
                  <button onClick={onRegister} disabled={busy || myAgents.length === 0} className="w-full py-2 rounded bg-sky-500/80 hover:bg-sky-500 text-white text-sm font-bold disabled:opacity-50">
                    {busy ? '处理中…' : '报名参赛(钱包签名两笔交易)'}
                  </button>
                </div>
              ) : (
                <p className="text-sm text-slate-500 py-4 text-center">本赛季未报名,或报名已截止</p>
              )}
            </section>
          </div>

          {/* 策略配置面板 */}
          <aside className="glass p-5 h-fit">
            <h3 className="font-bold mb-3">策略配置</h3>
            {!mine ? (
              <p className="text-sm text-slate-500 py-4 text-center">报名后可配置策略</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="text-xs text-slate-400 mb-2">风险画像</div>
                  <div className="grid grid-cols-4 gap-1">
                    {RISK_PROFILES.map((r) => (
                      <button
                        key={r.key}
                        onClick={() => setPb({ riskProfile: r.key })}
                        className={`py-1.5 rounded text-xs ${playbookDraft?.riskProfile === r.key ? 'bg-sky-500/80 text-white' : 'bg-white/10 text-slate-300 hover:bg-white/20'}`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-400 mb-2">资金分配(目标占比 %)</div>
                  {(['fixed_yield', 'spot', 'perp'] as const).map((k) => (
                    <label key={k} className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-slate-300">{{ fixed_yield: '固定收益', spot: '现货', perp: '永续' }[k]}</span>
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
                  <div className="text-xs text-slate-400 mb-2">护栏(留空 = 用预设档数值)</div>
                  {([['maxDailyLossPct', '日回撤熔断 %'], ['maxDrawdownPct', '累计回撤降级 %'], ['minCashBufferPct', '现金缓冲下限 %']] as const).map(([k, label]) => (
                    <label key={k} className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-slate-300">{label}</span>
                      <input
                        type="number"
                        min={0}
                        value={guardrails[k] ?? ''}
                        placeholder="预设"
                        onChange={(e) =>
                          setPb({ guardrails: { ...guardrails, [k]: e.target.value === '' ? undefined : Number(e.target.value) } })
                        }
                        className="w-20 bg-white/10 rounded px-2 py-1 text-right"
                      />
                    </label>
                  ))}
                </div>
                <details className="text-xs">
                  <summary className="text-slate-400 cursor-pointer hover:text-slate-200">高级:完整配置 JSON</summary>
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
                  保存策略(赛季中随时可改)
                </button>
                <p className="text-[10px] text-slate-500">agent 每轮决策消耗燃料;燃料耗尽将进入决策停机,已有仓位继续计收益</p>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}
