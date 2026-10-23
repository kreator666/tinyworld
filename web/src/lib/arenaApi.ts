// 竞技场(Arena)接口:赛季列表/详情/报名/策略配置/紧急冻结/净值曲线
import { apiCall, type UnsignedTx } from './agentApi'

export interface ArenaSeason {
  id: string
  chain_key: string
  season_address: string
  account_impl_address: string
  usdc_address: string
  principal_usd: string
  fuel_usd: string
  start_ts: number
  end_ts: number
  status: string // created/open/active/settling/settled(派生)
  config: Record<string, unknown> & { llmModel?: string }
  created_at: string
}

export interface LeaderboardEntry {
  season_id: string
  chain_key: string
  token_id: string
  owner: string
  account_address: string
  phase: string // active/frozen/settled
  nav_usd: string
  name: string | null
  register_tx: string
}

export interface MyArenaAccount {
  account: {
    season_id: string
    account_address: string
    phase: string
    nav_usd: string | null
  }
  playbook: Record<string, unknown> | null
  playbookVersion: number
  fuel: { balance_usd: string; total_spent_usd: string; decision_halted: boolean } | null
  llmModel: string
}

export interface ArenaSnapshot {
  nav_usd: string
  breakdown: Record<string, number>
  created_at: string
}

export const listArenaSeasons = (all = false) =>
  apiCall<{ seasons: ArenaSeason[] }>(`/arena/seasons${all ? '?all=1' : ''}`)

export const getArenaSeason = (id: string) =>
  apiCall<{ season: ArenaSeason; leaderboard: LeaderboardEntry[] }>(`/arena/seasons/${id}`)

/** 报名:返回待签名交易(approve + register),前端钱包逐笔签名 */
export const arenaRegister = (id: string, tokenId: number) =>
  apiCall<{ ok: boolean; txs: UnsignedTx[]; season: { id: string; principal_usd: string; fuel_usd: string } }>(
    `/arena/seasons/${id}/register`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tokenId }) },
  )

/** 注册确认:后端解析链上 Registered 事件落库 */
export const arenaRegisterConfirm = (id: string, tokenId: number, txHash: string) =>
  apiCall<{ ok: boolean; account: { account_address: string } }>(`/arena/seasons/${id}/register-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenId, txHash }),
  })

export const getMyArenaAccount = (id: string, tokenId: number) =>
  apiCall<MyArenaAccount>(`/arena/seasons/${id}/agents/${tokenId}`)

export const saveArenaPlaybook = (id: string, tokenId: number, config: Record<string, unknown>) =>
  apiCall<{ ok: boolean; version: number }>(`/arena/seasons/${id}/agents/${tokenId}/playbook`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  })

export const arenaFreeze = (id: string, tokenId: number) =>
  apiCall<{ ok: boolean; txs: UnsignedTx[] }>(`/arena/seasons/${id}/agents/${tokenId}/freeze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })

export const arenaFreezeConfirm = (id: string, tokenId: number, txHash: string) =>
  apiCall<{ ok: boolean }>(`/arena/seasons/${id}/agents/${tokenId}/freeze-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenId, txHash }),
  })

export const arenaWithdraw = (id: string, tokenId: number) =>
  apiCall<{ ok: boolean; txs: UnsignedTx[] }>(`/arena/seasons/${id}/agents/${tokenId}/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })

export const arenaWithdrawConfirm = (id: string, tokenId: number, txHash: string) =>
  apiCall<{ ok: boolean }>(`/arena/seasons/${id}/agents/${tokenId}/withdraw-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenId, txHash }),
  })

export interface ArenaTrade {
  id: string
  season_id: string
  token_id: string
  strategy_type: string // fixed_yield / spot / perp
  action: string // supply / withdraw / swap / gmx_order
  tx_hash: string | null
  pnl_usd: string | null
  payload: { reason?: string; params?: Record<string, string>; [k: string]: unknown }
  created_at: string
}

export const getArenaTrades = (id: string, tokenId: number) =>
  apiCall<{ trades: ArenaTrade[] }>(`/arena/seasons/${id}/agents/${tokenId}/trades?limit=100`)

export const getArenaSnapshots = (id: string, tokenId: number) =>
  apiCall<{ snapshots: ArenaSnapshot[] }>(`/arena/seasons/${id}/agents/${tokenId}/snapshots?limit=200`)

// ============================================================
// 管理端(admin JWT)
// ============================================================

export const adminCreateSeason = (body: Record<string, unknown>) =>
  apiCall<{ ok: boolean; season: ArenaSeason }>('/admin/arena/seasons', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const adminUpdateSeason = (id: string, body: Record<string, unknown>) =>
  apiCall<{ ok: boolean; season: ArenaSeason }>(`/admin/arena/seasons/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

/** 建议白名单(按链配置预填,管理端 review 用) */
export interface WhitelistTemplateEntry {
  target: string
  selector: string
  allowed: boolean
  note: string
}
export const getWhitelistTemplate = () =>
  apiCall<{ entries: WhitelistTemplateEntry[] }>('/arena/whitelist-template')

/** 一键部署:三笔部署交易 + 预测地址 + 执行地址展示 */
export const adminDeployTxs = (id: string) =>
  apiCall<{
    ok: boolean
    txs: UnsignedTx[]
    predicted: { accountImpl: string; seasonImpl: string; seasonProxy: string }
    executor: string
  }>(`/admin/arena/seasons/${id}/deploy-txs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })

export const adminDeployConfirm = (id: string, txHashes: string[]) =>
  apiCall<{ ok: boolean; accountImpl: string; seasonImpl: string; seasonProxy: string }>(
    `/admin/arena/seasons/${id}/deploy-confirm`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHashes }) },
  )

export const adminWhitelistTxs = (id: string, entries: { target: string; selector: string; allowed: boolean }[]) =>
  apiCall<{ ok: boolean; txs: UnsignedTx[] }>(`/admin/arena/seasons/${id}/whitelist-txs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  })

export const adminWhitelistConfirm = (id: string, txHash: string) =>
  apiCall<{ ok: boolean }>(`/admin/arena/seasons/${id}/whitelist-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash }),
  })

export const adminArenaSettle = (id: string, tokenId: number) =>
  apiCall<{ ok: boolean; navUsd: number; txHash: string }>(`/admin/arena/seasons/${id}/agents/${tokenId}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
