import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { t, useI18n } from '../i18n'
import { useAppStore } from '../store/appStore'
import { useChainConfig } from '../store/chainConfigStore'
import {
  adminArenaSettle,
  adminCreateSeason,
  adminSettleConfirm,
  adminSettleTxs,
  adminDeployConfirm,
  adminDeployTxs,
  adminUpdateSeason,
  adminWhitelistConfirm,
  adminWhitelistTxs,
  getArenaSeason,
  getWhitelistTemplate,
  listArenaSeasons,
  type ArenaSeason,
  type LeaderboardEntry,
} from '../lib/arenaApi'
import type { EvmUnsignedTx } from '../lib/agentApi'
import { sendTransactions } from '../lib/chainDispatch'
import { isIdentityOwner } from '../lib/chain'
import { agentApiBase } from '../lib/agentApi'

/** 从 /chains 读全部 EVM 链的 defi.usdc(后端权威;零地址视为未配置 → 空串) */
async function fetchUsdcMap(): Promise<Record<string, string>> {
  const res = await fetch(`${agentApiBase()}/chains`)
  if (!res.ok) return {}
  const data = (await res.json()) as { chains: { chain_key: string; config?: { defi?: { usdc?: string } } }[] }
  const map: Record<string, string> = {}
  for (const c of data.chains) {
    const usdc = c.config?.defi?.usdc
    if (usdc && usdc !== '0x0000000000000000000000000000000000000000') map[c.chain_key] = usdc
  }
  return map
}

// ============================================================
// 竞技场管理页(/admin/arena,需管理员):
// 建赛季 → 一键部署 → 白名单上链 → 自动开赛 → 结算归档
// ============================================================

const statusText = (status: string) => {
  const v = t(`arena.status.${status}`)
  return v === `arena.status.${status}` ? status : v
}

const toTs = (v: string) => Math.floor(new Date(v).getTime() / 1000)
const fromTs = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16)
const short = (a: string) => (a ? `${a.slice(0, 8)}…${a.slice(-4)}` : '-')
const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleString('zh-CN')

/** 常用协议方法白名单模板(按链部署情况选用) */
const WHITELIST_TEMPLATES: Record<string, { target: string; selector: string; noteKey: string }[]> = {
  aave: [
    { target: 'USDC', selector: 'approve(address,uint256)', noteKey: 'aaveApprove' },
    { target: 'POOL', selector: 'supply(address,uint256,address,uint16)', noteKey: 'aaveSupply' },
    { target: 'POOL', selector: 'withdraw(address,uint256,address)', noteKey: 'aaveWithdraw' },
  ],
  gmx: [
    { target: 'USDC', selector: 'approve(address,uint256)', noteKey: 'gmxApprove' },
    { target: 'ROUTER', selector: 'multicall(bytes[])', noteKey: 'gmxMulticall' },
  ],
  dex: [
    { target: 'USDC', selector: 'approve(address,uint256)', noteKey: 'dexApprove' },
    { target: 'ROUTER', selector: 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)', noteKey: 'dexSwap' },
  ],
}

export default function AdminArenaPage() {
  const { t } = useI18n()
  const { showToast, connected, address } = useAppStore()
  const { chains, active } = useChainConfig()
  // 竞技场管理门槛 = 当前链 DIDIdentity 合约 owner(与铸造后台同一套链上判定)
  const [isAdmin, setIsAdmin] = useState(false)
  const [adminLoading, setAdminLoading] = useState(true)
  const evmChains = chains.filter((c) => (c.family ?? 'evm') === 'evm')
  const [seasons, setSeasons] = useState<ArenaSeason[]>([])
  const [detail, setDetail] = useState<Record<string, LeaderboardEntry[]>>({})
  const [busy, setBusy] = useState(false)
  // 默认窗口:开始 = 今天(现在),结束 = 3 个月后;开赛后随时可中途加入,故默认立即开赛
  const defaultStart = () => {
    const d = new Date()
    d.setSeconds(0, 0)
    return d.toISOString().slice(0, 16)
  }
  const defaultEnd = (start: string) => {
    const base = start ? new Date(start).getTime() : Date.now()
    const d = new Date(base + 90 * 24 * 3600 * 1000)
    return d.toISOString().slice(0, 16)
  }
  const [form, setForm] = useState({
    chain_key: '',
    usdc: '',
    title: '',
    principal: '60',
    fuel: '9',
    start: defaultStart(),
    end: defaultEnd(''),
    llmModel: '',
    inputPerM: '0.15',
    outputPerM: '0.45',
    markup: '1.0',
  })
  const [deployInfo, setDeployInfo] = useState<Record<string, { executor: string; predicted: string }>>({})
  const [wlDraft, setWlDraft] = useState<Record<string, string>>({})
  const [wlNotes, setWlNotes] = useState<Record<string, string[]>>({})

  const reload = useCallback(async () => {
    try {
      const r = await listArenaSeasons(true) // 管理端跨链全量
      setSeasons(r.seasons)
      const d: Record<string, LeaderboardEntry[]> = {}
      for (const s of r.seasons) {
        d[s.id] = (await getArenaSeason(s.id)).leaderboard
      }
      setDetail(d)
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('adminArena.toast.loadFail'))
    }
  }, [showToast])

  useEffect(() => {
    if (!connected || !address || active.family === 'solana') {
      setIsAdmin(false)
      setAdminLoading(false)
      return
    }
    isIdentityOwner(address as `0x${string}`)
      .then(setIsAdmin)
      .catch(() => setIsAdmin(false))
      .finally(() => setAdminLoading(false))
  }, [connected, address, active])

  useEffect(() => {
    if (isAdmin) reload()
  }, [isAdmin, reload])

  // 白名单模板:按赛季链配置预填(管理员 review 后确认即可)
  useEffect(() => {
    if (!isAdmin || seasons.length === 0) return
    for (const s of seasons) {
      if (wlDraft[s.id]) continue
      getWhitelistTemplate()
        .then((r) => {
          setWlDraft((d) =>
            d[s.id]
              ? d
              : {
                  ...d,
                  [s.id]: r.entries.map((e) => `${e.target}, ${e.selector}, ${e.allowed}`).join('\n'),
                },
          )
          setWlNotes((n) => ({ ...n, [s.id]: r.entries.map((e) => e.note) }))
        })
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, seasons.length])

  // 全链 USDC 配置表(一次拉取)
  const [usdcMap, setUsdcMap] = useState<Record<string, string>>({})
  useEffect(() => {
    fetchUsdcMap().then(setUsdcMap).catch(() => {})
  }, [])

  // 默认选链:优先选第一个已配置 USDC 的 EVM 链(如 Fuji/Avalanche),避免默认落到无 USDC 的 Sepolia
  useEffect(() => {
    if (evmChains.length === 0 || form.chain_key || Object.keys(usdcMap).length === 0) return
    const withUsdc = evmChains.find((c) => usdcMap[c.key])
    setForm((f) => ({ ...f, chain_key: (withUsdc ?? evmChains[0]).key }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evmChains, usdcMap])

  // 选链变化:预填该链配置的 USDC(用户可改;未配置则留空)
  useEffect(() => {
    if (!form.chain_key) return
    setForm((f) => ({ ...f, usdc: usdcMap[form.chain_key] ?? '' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.chain_key, usdcMap])

  const onCreate = async () => {
    if (!form.start || !form.end) return showToast(t('adminArena.toast.fillTime'))
    if (new Date(form.end).getTime() <= new Date(form.start).getTime()) {
      return showToast(t('adminArena.toast.endAfterStart'))
    }
    if (new Date(form.end).getTime() <= Date.now()) {
      return showToast(t('adminArena.toast.endAfterNow'))
    }
    setBusy(true)
    try {
      await adminCreateSeason({
        chain_key: form.chain_key,
        usdc_address: form.usdc,
        principal_usd: Number(form.principal),
        fuel_usd: Number(form.fuel),
        start_ts: toTs(form.start),
        end_ts: toTs(form.end),
        config: {
          title: form.title || t('arena.seasonTitle'),
          llmModel: form.llmModel || undefined,
          llmPricing: { inputPerM: Number(form.inputPerM), outputPerM: Number(form.outputPerM) },
          priceMarkup: Number(form.markup),
        },
      })
      showToast(t('adminArena.toast.createOk'))
      reload()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('adminArena.toast.createFail'))
    } finally {
      setBusy(false)
    }
  }

  /** 赛季结算:owner 钱包签名(熔断 + 逐账户 recordResult);服务端自动结算仅当服务端密钥=合约 owner 时可用 */
  const onSettleSeason = async (id: string) => {
    if (!address) return
    const pending = (detail[id] ?? []).filter((e) => e.phase !== 'settled')
    if (!window.confirm(t('adminArena.confirm.settle', { count: pending.length + 1, pending: pending.length }))) return
    setBusy(true)
    try {
      const r = await adminSettleTxs(id)
      showToast(t('adminArena.toast.settleSign', { count: r.txs.length }))
      const txHashes = await sendTransactions(address, r.txs)
      showToast(t('arena.toast.broadcast'))
      const c = await adminSettleConfirm(id, txHashes)
      showToast(t('adminArena.toast.settleDone', { settled: c.settled }))
      reload()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('adminArena.toast.settleFail'))
    } finally {
      setBusy(false)
    }
  }

  const onDeploy = async (id: string) => {
    if (!address) return
    setBusy(true)
    // nonce 竞态自愈:上一批交易残留(已广播未确认/被替换)会让钱包报 nonce too low,
    // 此时重新拉取部署包(后端按最新 pending nonce 重新预测)重试一次
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await adminDeployTxs(id)
        setDeployInfo((d) => ({ ...d, [id]: { executor: r.executor, predicted: t('adminArena.season.predictedValue', { account: r.predicted.accountImpl, proxy: r.predicted.seasonProxy }) } }))
        showToast(t('adminArena.toast.deploySign', { nonce: String((r.txs[0] as EvmUnsignedTx).nonce) }))
        const txHashes = await sendTransactions(address, r.txs)
        showToast(t('adminArena.toast.deployBroadcast'))
        const c = await adminDeployConfirm(id, txHashes)
        showToast(t('adminArena.toast.deployDone', { proxy: c.seasonProxy.slice(0, 10) }))
        reload()
        return
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (attempt === 0 && /nonce/i.test(msg)) {
          showToast(t('adminArena.toast.nonceConflict'))
          continue
        }
        showToast(msg || t('adminArena.toast.deployFail'))
        return
      } finally {
        setBusy(false)
      }
    }
  }

  const onApplyWhitelist = async (id: string) => {
    const lines = (wlDraft[id] ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) return showToast(t('adminArena.toast.wlEmpty'))
    const entries = lines.map((l) => {
      const [target, selector, allowed] = l.split(/[,,\s]+/).map((x) => x.trim())
      return { target, selector, allowed: allowed !== 'false' }
    })
    for (const e of entries) {
      if (!e.target?.match(/^0x[0-9a-fA-F]{40}$/)) return showToast(t('adminArena.toast.wlBadTarget', { target: e.target ?? '' }))
    }
    setBusy(true)
    try {
      const r = await adminWhitelistTxs(id, entries)
      showToast(t('adminArena.toast.wlSign'))
      const txHashes = await sendTransactions(address!, r.txs)
      await adminWhitelistConfirm(id, txHashes[txHashes.length - 1])
      showToast(t('adminArena.toast.wlOk'))
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('adminArena.toast.wlFail'))
    } finally {
      setBusy(false)
    }
  }

  const onSettle = async (id: string, tokenId: number) => {
    setBusy(true)
    try {
      const r = await adminArenaSettle(id, tokenId)
      showToast(t('adminArena.toast.accountSettled', { nav: `$${r.navUsd.toFixed(2)}` }))
      reload()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('adminArena.toast.settleFail'))
    } finally {
      setBusy(false)
    }
  }

  if (adminLoading) return <div className="mx-auto max-w-7xl px-4 py-10 text-center text-slate-400">{t('adminArena.loading')}</div>
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10 text-center">
        <p className="text-slate-400 mb-3">{t('adminArena.notAdmin')}</p>
        <p className="text-xs text-slate-500 break-all">{t('adminArena.notAdminDetail', { name: active.name })}</p>
        <Link to="/admin" className="text-sky-400 text-sm underline">{t('adminArena.backToAdmin')}</Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-2xl font-bold mb-1">{t('adminArena.title')}</h2>
          <p className="text-sm text-slate-400">{t('adminArena.subtitle')}</p>
        </div>
        <Link to="/arena" className="text-sm text-sky-400 underline">{t('adminArena.viewUserArena')}</Link>
      </div>

      {/* 创建赛季 */}
      <section className="glass p-5 mb-6">
        <h3 className="font-bold mb-3">{t('adminArena.create.step')}</h3>
        <div className="grid sm:grid-cols-3 lg:grid-cols-4 gap-3 text-sm">
          <label className="text-xs text-slate-400">{t('adminArena.create.chain')}
            <select value={form.chain_key} onChange={(e) => setForm({ ...form, chain_key: e.target.value })} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5">
              {evmChains.map((c) => <option key={c.key} value={c.key} className="bg-slate-800">{c.name}({c.key})</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-400 sm:col-span-2">{t('adminArena.create.usdc')}
            <input value={form.usdc} onChange={(e) => setForm({ ...form, usdc: e.target.value })} placeholder="0x…" className="mt-1 w-full bg-white/10 rounded px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs text-slate-400">{t('adminArena.create.title')}
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('arena.seasonTitle')} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">{t('adminArena.create.principal')}
            <input type="number" value={form.principal} onChange={(e) => setForm({ ...form, principal: e.target.value })} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">{t('adminArena.create.fuel')}
            <input type="number" value={form.fuel} onChange={(e) => setForm({ ...form, fuel: e.target.value })} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">{t('adminArena.create.start')}
            <input type="datetime-local" value={form.start} onChange={(e) => {
              const start = e.target.value
              setForm((f) => ({ ...f, start, end: f.end && new Date(f.end).getTime() > new Date(start).getTime() ? f.end : defaultEnd(start) }))
            }} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">{t('adminArena.create.end')}
            <input type="datetime-local" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">{t('adminArena.create.llm')}
            <input value={form.llmModel} onChange={(e) => setForm({ ...form, llmModel: e.target.value })} placeholder={t('adminArena.create.llmPlaceholder')} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">{t('adminArena.create.inputPrice')}
            <input type="number" step="0.01" value={form.inputPerM} onChange={(e) => setForm({ ...form, inputPerM: e.target.value })} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">{t('adminArena.create.outputPrice')}
            <input type="number" step="0.01" value={form.outputPerM} onChange={(e) => setForm({ ...form, outputPerM: e.target.value })} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">{t('adminArena.create.markup')}
            <input type="number" step="0.1" value={form.markup} onChange={(e) => setForm({ ...form, markup: e.target.value })} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
        </div>
        <p className="text-[10px] text-slate-500 mt-2">{t('adminArena.create.condition')}</p>
        <button onClick={onCreate} disabled={busy} className="mt-3 px-6 py-2 rounded bg-sky-500/80 hover:bg-sky-500 text-white text-sm font-bold disabled:opacity-50">{t('adminArena.create.submit')}</button>
      </section>

      {/* 赛季管理 */}
      {seasons.map((s) => (
        <section key={s.id} className="glass p-5 mb-4">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div>
              <span className="font-bold">{(s.config as { title?: string }).title ?? s.id}</span>
              <span className="text-xs text-slate-400 ml-2">{s.chain_key} · {statusText(s.status)}</span>
              <span className="block text-[10px] text-slate-500">{fmtTime(s.start_ts)} ~ {fmtTime(s.end_ts)} · {t('arena.seasonMeta', { p: `$${Number(s.principal_usd).toFixed(0)}`, f: Number(s.fuel_usd).toFixed(0), m: (s.config as { llmModel?: string }).llmModel ?? '-' })}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="text-[10px] text-emerald-300/80">{t('adminArena.season.autoStart')}</div>
              {s.status === 'settling' && (detail[s.id] ?? []).some((e) => e.phase !== 'settled') && (
                <button onClick={() => onSettleSeason(s.id)} disabled={busy} className="px-3 py-1 rounded bg-amber-500/80 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50">
                  {t('adminArena.season.settleTrigger')}
                </button>
              )}
            </div>
          </div>

          {/* 一键部署:字段全部预填,管理员签名广播即可 */}
          {s.status === 'created' && !s.season_address && (
            <div className="mb-3 bg-sky-500/5 border border-sky-500/20 rounded p-3">
              <div className="text-xs font-bold text-sky-300 mb-2">{t('adminArena.season.deployStep')}</div>
              <div className="grid sm:grid-cols-3 gap-2 text-[10px] text-slate-400 mb-2">
                <span>{t('adminArena.season.chain', { v: s.chain_key })}</span>
                <span>{t('adminArena.season.usdc', { v: short(s.usdc_address) })}</span>
                <span>{t('adminArena.season.principalFuel', { v: `$${Number(s.principal_usd).toFixed(0)} + $${Number(s.fuel_usd).toFixed(0)}U` })}</span>
                <span>{t('adminArena.season.window', { v: fmtTime(s.start_ts) })}</span>
                <span>{t('adminArena.season.executor', { v: short(deployInfo[s.id]?.executor ?? t('adminArena.season.executorPending')) })}</span>
                <span>{t('adminArena.season.predicted', { v: deployInfo[s.id]?.predicted ?? t('adminArena.season.predictedPending') })}</span>
              </div>
              <button onClick={() => onDeploy(s.id)} disabled={busy} className="px-4 py-1.5 rounded bg-sky-500/80 hover:bg-sky-500 text-white text-xs font-bold disabled:opacity-50">
                {t('adminArena.season.deployBtn')}
              </button>
            </div>
          )}
          {s.season_address && (
            <div className="mb-3 text-[10px] text-slate-500">{t('adminArena.season.deployedAddrs', { proxy: short(s.season_address), impl: short(s.account_impl_address) })}</div>
          )}

          {/* 白名单 */}
          <details className="text-xs mb-3">
            <summary className="text-slate-400 cursor-pointer hover:text-slate-200">{t('adminArena.season.wlStep')}</summary>
            <div className="mt-2 space-y-2">
              <div className="flex gap-3 flex-wrap text-[10px] text-slate-500 mb-2">
                {(wlNotes[s.id] ?? []).map((n, i) => (
                  <span key={i} className="bg-white/5 rounded px-2 py-1">{n}</span>
                ))}
              </div>
              <div className="flex gap-3 flex-wrap text-[10px] text-slate-500" style={{ display: 'none' }}>
                {Object.entries(WHITELIST_TEMPLATES).map(([k, rows]) => (
                  <div key={k} className="bg-white/5 rounded p-2">
                    <div className="font-bold text-slate-300 mb-1">{t('adminArena.season.wlTemplate', { name: k.toUpperCase() })}</div>
                    {rows.map((r, i) => <div key={i}>{r.selector} — {t(`adminArena.wlNote.${r.noteKey}`)}</div>)}
                  </div>
                ))}
              </div>
              <textarea
                value={wlDraft[s.id] ?? ''}
                onChange={(e) => setWlDraft({ ...wlDraft, [s.id]: e.target.value })}
                rows={4}
                placeholder={'0x…, supply(address,uint256,address,uint16), true\n0x…, transfer(address,uint256), false'}
                className="w-full bg-white/5 rounded p-2 font-mono text-[10px]"
              />
              <button onClick={() => onApplyWhitelist(s.id)} disabled={busy} className="px-4 py-1.5 rounded bg-amber-500/80 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50">{t('adminArena.season.wlBtn')}</button>
            </div>
          </details>

          {/* 参赛名单 */}
          <div className="text-xs">
            <div className="text-slate-400 mb-1">{t('adminArena.season.entrants', { count: (detail[s.id] ?? []).length })}</div>
            {(detail[s.id] ?? []).map((e) => (
              <div key={e.token_id} className="flex items-center justify-between py-1 border-b border-white/5">
                <span>{e.name ?? `Agent #${e.token_id}`} <span className="text-slate-500">{short(e.account_address)}</span></span>
                <span className="flex items-center gap-2">
                  <span className="text-slate-300">NAV {Number(e.nav_usd).toFixed(2)}</span>
                  <span className="text-slate-500">{e.phase}</span>
                  {e.phase !== 'settled' && (
                    <button onClick={() => onSettle(s.id, Number(e.token_id))} disabled={busy} className="px-2 py-0.5 rounded bg-sky-500/60 hover:bg-sky-500 text-[10px] disabled:opacity-50">{t('adminArena.season.settleBtn')}</button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
      {seasons.length === 0 && <p className="text-sm text-slate-500 text-center py-6">{t('adminArena.season.empty')}</p>}
    </div>
  )
}
