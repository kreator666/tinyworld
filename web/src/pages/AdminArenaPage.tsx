import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import { useChainConfig } from '../store/chainConfigStore'
import {
  adminArenaSettle,
  adminCreateSeason,
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

const STATUS_LABEL: Record<string, string> = {
  created: '待部署',
  open: '报名中',
  active: '赛季中',
  settling: '待结算',
  settled: '已结束',
}

const toTs = (v: string) => Math.floor(new Date(v).getTime() / 1000)
const fromTs = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16)
const short = (a: string) => (a ? `${a.slice(0, 8)}…${a.slice(-4)}` : '-')
const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleString('zh-CN')

/** 常用协议方法白名单模板(按链部署情况选用) */
const WHITELIST_TEMPLATES: Record<string, { target: string; selector: string; note: string }[]> = {
  aave: [
    { target: 'USDC', selector: 'approve(address,uint256)', note: 'USDC.approve → Aave Pool' },
    { target: 'POOL', selector: 'supply(address,uint256,address,uint16)', note: 'Aave Pool.supply' },
    { target: 'POOL', selector: 'withdraw(address,uint256,address)', note: 'Aave Pool.withdraw' },
  ],
  gmx: [
    { target: 'USDC', selector: 'approve(address,uint256)', note: 'USDC.approve → GMX Router' },
    { target: 'ROUTER', selector: 'multicall(bytes[])', note: 'GMX ExchangeRouter.multicall(订单)' },
  ],
  dex: [
    { target: 'USDC', selector: 'approve(address,uint256)', note: 'USDC.approve → DEX Router' },
    { target: 'ROUTER', selector: 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)', note: 'DEX 代币兑换' },
  ],
}

export default function AdminArenaPage() {
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
      showToast(err instanceof Error ? err.message : '加载失败')
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
    if (!form.start || !form.end) return showToast('请填写起止时间')
    if (new Date(form.end).getTime() <= new Date(form.start).getTime()) {
      return showToast('结束时间必须晚于开始时间')
    }
    if (new Date(form.end).getTime() <= Date.now()) {
      return showToast('结束时间必须晚于现在')
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
          title: form.title || '竞技赛季',
          llmModel: form.llmModel || undefined,
          llmPricing: { inputPerM: Number(form.inputPerM), outputPerM: Number(form.outputPerM) },
          priceMarkup: Number(form.markup),
        },
      })
      showToast('赛季已创建(待部署)')
      reload()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '创建失败')
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
        setDeployInfo((d) => ({ ...d, [id]: { executor: r.executor, predicted: `账户 ${r.predicted.accountImpl} / 代理 ${r.predicted.seasonProxy}` } }))
        showToast(`请在钱包中依次确认三笔部署交易(显式 nonce ${(r.txs[0] as EvmUnsignedTx).nonce} 起,账户实现 → 赛季实现 → 赛季代理)`)
        const txHashes = await sendTransactions(address, r.txs)
        showToast('交易已广播,等待链上确认并回填地址…')
        const c = await adminDeployConfirm(id, txHashes)
        showToast(`部署完成:赛季代理 ${c.seasonProxy.slice(0, 10)}…`)
        reload()
        return
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (attempt === 0 && /nonce/i.test(msg)) {
          showToast('检测到 nonce 冲突(可能有未确认交易残留),已自动重新生成部署包,请再次签名')
          continue
        }
        showToast(msg || '部署失败')
        return
      } finally {
        setBusy(false)
      }
    }
  }

  const onApplyWhitelist = async (id: string) => {
    const lines = (wlDraft[id] ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) return showToast('每行一条:目标合约地址, 方法签名或0x选择器, true/false')
    const entries = lines.map((l) => {
      const [target, selector, allowed] = l.split(/[,,\s]+/).map((x) => x.trim())
      return { target, selector, allowed: allowed !== 'false' }
    })
    for (const e of entries) {
      if (!e.target?.match(/^0x[0-9a-fA-F]{40}$/)) return showToast(`目标地址非法: ${e.target}(支持占位符 USDC/POOL/ROUTER 需先替换为实际地址)`)
    }
    setBusy(true)
    try {
      const r = await adminWhitelistTxs(id, entries)
      showToast('请在钱包中确认白名单交易')
      const txHashes = await sendTransactions(address!, r.txs)
      await adminWhitelistConfirm(id, txHashes[txHashes.length - 1])
      showToast('白名单已上链生效')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '白名单上链失败')
    } finally {
      setBusy(false)
    }
  }

  const onSettle = async (id: string, tokenId: number) => {
    setBusy(true)
    try {
      const r = await adminArenaSettle(id, tokenId)
      showToast(`已结算:NAV $${r.navUsd.toFixed(2)}`)
      reload()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '结算失败')
    } finally {
      setBusy(false)
    }
  }

  if (adminLoading) return <div className="mx-auto max-w-7xl px-4 py-10 text-center text-slate-400">加载中…</div>
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10 text-center">
        <p className="text-slate-400 mb-3">该页面仅管理员可见</p>
        <p className="text-xs text-slate-500 break-all">当前地址不是 {active.name} 上平台合约(DIDIdentity)的 owner。请用部署合约的 owner 钱包登录;不同链的 owner 各自独立。</p>
        <Link to="/admin" className="text-sky-400 text-sm underline">返回管理后台</Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-2xl font-bold mb-1">竞技场管理</h2>
          <p className="text-sm text-slate-400">建赛季模板 → 一键部署(签名三笔)→ 白名单核对上链 → 到点自动开赛,无需人工放行</p>
        </div>
        <Link to="/arena" className="text-sm text-sky-400 underline">查看用户端竞技场页</Link>
      </div>

      {/* 创建赛季 */}
      <section className="glass p-5 mb-6">
        <h3 className="font-bold mb-3">第 1 步:创建赛季模板(仅写数据库,不上链)</h3>
        <div className="grid sm:grid-cols-3 lg:grid-cols-4 gap-3 text-sm">
          <label className="text-xs text-slate-400">链
            <select value={form.chain_key} onChange={(e) => setForm({ ...form, chain_key: e.target.value })} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5">
              {evmChains.map((c) => <option key={c.key} value={c.key} className="bg-slate-800">{c.name}({c.key})</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-400 sm:col-span-2">USDC 合约地址(已按链配置预填,可改)
            <input value={form.usdc} onChange={(e) => setForm({ ...form, usdc: e.target.value })} placeholder="0x…" className="mt-1 w-full bg-white/10 rounded px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs text-slate-400">赛季标题
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="竞技赛季" className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">本金(USDC)
            <input type="number" value={form.principal} onChange={(e) => setForm({ ...form, principal: e.target.value })} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">燃料费(USDC)
            <input type="number" value={form.fuel} onChange={(e) => setForm({ ...form, fuel: e.target.value })} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">开始时间(默认现在;开赛后也可随时加入,只控制交易开放时间)
            <input type="datetime-local" value={form.start} onChange={(e) => {
              const start = e.target.value
              setForm((f) => ({ ...f, start, end: f.end && new Date(f.end).getTime() > new Date(start).getTime() ? f.end : defaultEnd(start) }))
            }} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">结束时间
            <input type="datetime-local" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">固定模型(留空=全局模型)
            <input value={form.llmModel} onChange={(e) => setForm({ ...form, llmModel: e.target.value })} placeholder="如 qwen2.5-7b" className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">输入单价 /1M tokens
            <input type="number" step="0.01" value={form.inputPerM} onChange={(e) => setForm({ ...form, inputPerM: e.target.value })} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">输出单价 /1M tokens
            <input type="number" step="0.01" value={form.outputPerM} onChange={(e) => setForm({ ...form, outputPerM: e.target.value })} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-slate-400">价格加成
            <input type="number" step="0.1" value={form.markup} onChange={(e) => setForm({ ...form, markup: e.target.value })} className="mt-1 w-full bg-white/10 rounded px-2 py-1.5" />
          </label>
        </div>
        <p className="text-[10px] text-slate-500 mt-2">开赛条件:合约部署 + 白名单上链 + 有效的 USDC 与模型配置(模型默认带全局的);部署完成即接受报名,到开始时间自动开赛</p>
        <button onClick={onCreate} disabled={busy} className="mt-3 px-6 py-2 rounded bg-sky-500/80 hover:bg-sky-500 text-white text-sm font-bold disabled:opacity-50">创建赛季模板</button>
      </section>

      {/* 赛季管理 */}
      {seasons.map((s) => (
        <section key={s.id} className="glass p-5 mb-4">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div>
              <span className="font-bold">{(s.config as { title?: string }).title ?? s.id}</span>
              <span className="text-xs text-slate-400 ml-2">{s.chain_key} · {STATUS_LABEL[s.status] ?? s.status}</span>
              <span className="block text-[10px] text-slate-500">{fmtTime(s.start_ts)} ~ {fmtTime(s.end_ts)} · 本金 ${Number(s.principal_usd).toFixed(0)} + 燃料 ${Number(s.fuel_usd).toFixed(0)}U · 模型 {(s.config as { llmModel?: string }).llmModel ?? '-'}</span>
            </div>
            <div className="text-[10px] text-emerald-300/80">部署完成即就绪,到开始时间自动开赛,无需人工开放</div>
          </div>

          {/* 一键部署:字段全部预填,管理员签名广播即可 */}
          {s.status === 'created' && !s.season_address && (
            <div className="mb-3 bg-sky-500/5 border border-sky-500/20 rounded p-3">
              <div className="text-xs font-bold text-sky-300 mb-2">第 2 步:一键部署合约(三笔交易,字段已按赛季参数预填,只需签名)</div>
              <div className="grid sm:grid-cols-3 gap-2 text-[10px] text-slate-400 mb-2">
                <span>链:{s.chain_key}</span>
                <span>USDC:{short(s.usdc_address)}</span>
                <span>本金/燃料:${Number(s.principal_usd).toFixed(0)} + ${Number(s.fuel_usd).toFixed(0)}U</span>
                <span>赛季窗口:{fmtTime(s.start_ts)}</span>
                <span>执行地址:{short(deployInfo[s.id]?.executor ?? '(生成时展示)')}</span>
                <span>预测地址:{deployInfo[s.id]?.predicted ?? '签名前生成'}</span>
              </div>
              <button onClick={() => onDeploy(s.id)} disabled={busy} className="px-4 py-1.5 rounded bg-sky-500/80 hover:bg-sky-500 text-white text-xs font-bold disabled:opacity-50">
                生成部署交易并签名
              </button>
            </div>
          )}
          {s.season_address && (
            <div className="mb-3 text-[10px] text-slate-500">赛季代理 {short(s.season_address)} · 账户实现 {short(s.account_impl_address)}</div>
          )}

          {/* 白名单 */}
          <details className="text-xs mb-3">
            <summary className="text-slate-400 cursor-pointer hover:text-slate-200">第 3 步:协议白名单(已按链配置预填,核对后点"白名单上链签名"即可)</summary>
            <div className="mt-2 space-y-2">
              <div className="flex gap-3 flex-wrap text-[10px] text-slate-500 mb-2">
                {(wlNotes[s.id] ?? []).map((n, i) => (
                  <span key={i} className="bg-white/5 rounded px-2 py-1">{n}</span>
                ))}
              </div>
              <div className="flex gap-3 flex-wrap text-[10px] text-slate-500" style={{ display: 'none' }}>
                {Object.entries(WHITELIST_TEMPLATES).map(([k, rows]) => (
                  <div key={k} className="bg-white/5 rounded p-2">
                    <div className="font-bold text-slate-300 mb-1">{k.toUpperCase()} 模板</div>
                    {rows.map((r, i) => <div key={i}>{r.selector} — {r.note}</div>)}
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
              <button onClick={() => onApplyWhitelist(s.id)} disabled={busy} className="px-4 py-1.5 rounded bg-amber-500/80 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50">白名单上链(钱包签名)</button>
            </div>
          </details>

          {/* 参赛名单 */}
          <div className="text-xs">
            <div className="text-slate-400 mb-1">参赛者 {(detail[s.id] ?? []).length} 人</div>
            {(detail[s.id] ?? []).map((e) => (
              <div key={e.token_id} className="flex items-center justify-between py-1 border-b border-white/5">
                <span>{e.name ?? `Agent #${e.token_id}`} <span className="text-slate-500">{short(e.account_address)}</span></span>
                <span className="flex items-center gap-2">
                  <span className="text-slate-300">NAV {Number(e.nav_usd).toFixed(2)}</span>
                  <span className="text-slate-500">{e.phase}</span>
                  {e.phase !== 'settled' && (
                    <button onClick={() => onSettle(s.id, Number(e.token_id))} disabled={busy} className="px-2 py-0.5 rounded bg-sky-500/60 hover:bg-sky-500 text-[10px] disabled:opacity-50">结算</button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
      {seasons.length === 0 && <p className="text-sm text-slate-500 text-center py-6">还没有赛季,用上方表单创建第一个</p>}
    </div>
  )
}
