// 生存模式(Survival)接口:领养/动作/复活/动作日志/排行榜/设置
// 与 agentApi 同源(base 由 VITE_AGENT_API 决定),所有请求带 X-Chain-Key + Bearer JWT;
// 独立封装是为了让错误携带 HTTP status(action 接口 401 需要弹登录、502/超时需要降级提示)
import { useAppStore } from '../store/appStore'
import { getActiveChain } from '../store/chainConfigStore'
import { t } from '../i18n'

const AGENT_API = (import.meta.env.VITE_AGENT_API as string | undefined) ?? ''

export type SurvivalPetStatus = 'alive' | 'weak' | 'dormant' | 'dead'
export type SurvivalActionKind = 'feed' | 'clean' | 'work' | 'heal'

export interface SurvivalStats {
  satiety: number
  cleanliness: number
  mood: number
  vitality: number
}

export interface SurvivalPetDto {
  chainKey: string
  tokenId: number
  status: SurvivalPetStatus
  stats: SurvivalStats
  weakSince: number | null
  principalYocto: string
  earningsYocto: string
  yieldYocto: string
  credits: { balanceUsd: string; burnedUsd: string }
  deathCount: number
  reviveCount: number
  bornAt: number
  lastActionAt: number | null
  cooldowns: { feed: number; clean: number; work: number }
  stakeTx: string
}

export interface SurvivalActionDto {
  id: string
  kind: SurvivalActionKind
  status: 'executed' | 'rejected' | 'failed' | 'planned'
  plan: unknown
  result: unknown
  txHash: string | null
  creditCostUsd: string
  pnlYocto: string | null
  createdAt: number
}

export interface SurvivalLeaderboardEntry {
  tokenId: number
  name: string
  status: SurvivalPetStatus
  earningsYocto: string
  yieldYocto: string
  deathCount: number
  ageHours: number
}

export interface SurvivalSettings {
  riskProfile?: string
  maxSinglePct?: number
}

/** 携带 HTTP status 的错误:401 弹登录、502/504/超时提示宠物没响应 */
export class SurvivalApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'SurvivalApiError'
    this.status = status
  }
}

async function survivalCall<T>(path: string, init?: RequestInit): Promise<T> {
  const token = useAppStore.getState().agentToken
  const headers: Record<string, string> = { 'X-Chain-Key': getActiveChain().key }
  if (init?.headers) Object.assign(headers, init.headers as Record<string, string>)
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${AGENT_API}${path}`, { ...init, headers })
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new SurvivalApiError(res.status, data?.error ?? t('agentApi.serviceError', { status: res.status }))
  return data as T
}

const post = <T,>(path: string, body?: unknown) =>
  survivalCall<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

export const getSurvivalLeaderboard = (limit = 50) =>
  survivalCall<{ entries: SurvivalLeaderboardEntry[] }>(`/survival/leaderboard?limit=${limit}`)

export const getSurvivalPet = (tokenId: number) =>
  survivalCall<{ pet: SurvivalPetDto | null }>(`/survival/pet/${tokenId}`)

/** 领养:principal 为本金档位(NEAR),需登录 + owner */
export const adoptSurvivalPet = (tokenId: number, principal: 1 | 2 | 5) =>
  post<{ pet: SurvivalPetDto }>(`/survival/pet/${tokenId}/adopt`, { principal })

/** 执行动作:同步执行可能 10-30s,调用方需挂 loading;需登录 + owner */
export const survivalAction = (tokenId: number, kind: SurvivalActionKind) =>
  post<{ action: SurvivalActionDto }>(`/survival/pet/${tokenId}/action`, { kind })

/** 复活:需登录 + owner */
export const reviveSurvivalPet = (tokenId: number) =>
  post<{ pet: SurvivalPetDto }>(`/survival/pet/${tokenId}/revive`)

export const getSurvivalActions = (tokenId: number, limit = 20) =>
  survivalCall<{ actions: SurvivalActionDto[] }>(`/survival/pet/${tokenId}/actions?limit=${limit}`)

export const putSurvivalSettings = (tokenId: number, settings: SurvivalSettings) =>
  survivalCall<{ settings: SurvivalSettings }>(`/survival/pet/${tokenId}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })

/** NEAR 金额换算:yocto → N(保留 2-4 位小数,按数量级取精度) */
export function formatNear(yocto: string | null | undefined): string {
  const v = Number(yocto ?? '0') / 1e24
  if (!Number.isFinite(v)) return '0'
  if (Math.abs(v) >= 100) return v.toFixed(2)
  if (Math.abs(v) >= 1) return v.toFixed(3)
  return v.toFixed(4)
}
