import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import type { Proposal } from '../policy/engine'

// ============================================================
// DeFi 审批记录(M4,设计文档 §10):超限额/熔断提案等人工放行
// ============================================================

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed'

export interface ApprovalRow {
  id: string
  token_id: number
  proposal: Proposal
  agent_reason: string | null
  status: ApprovalStatus
  tx_hash: string | null
  created_at: string
  resolved_at: string | null
}

export interface Approval {
  id: string
  tokenId: number
  proposal: Proposal
  agentReason: string | null
  status: ApprovalStatus
  txHash: string | null
  createdAt: string
  resolvedAt: string | null
}

function toApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    tokenId: Number(r.token_id), // NUMERIC 列 PGlite 返回字符串,收敛回 number
    proposal: typeof r.proposal === 'string' ? JSON.parse(r.proposal) : r.proposal,
    agentReason: r.agent_reason,
    status: r.status,
    txHash: r.tx_hash,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }
}

/** 该 Agent 的审批列表:pending 在前,其余按时间倒序 */
export async function listApprovals(chainKey: string, tokenId: number): Promise<Approval[]> {
  const db = await getDb()
  const res = await db.query<ApprovalRow>(
    `SELECT * FROM approvals WHERE chain_key = $1 AND token_id = $2
     ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC`,
    [chainKey, tokenId],
  )
  return res.rows.map(toApproval)
}

/** 按 id 查审批单(限定链,防跨链取到同 id 记录) */
export async function getApproval(chainKey: string, id: string): Promise<Approval | null> {
  const db = await getDb()
  const res = await db.query<ApprovalRow>('SELECT * FROM approvals WHERE chain_key = $1 AND id = $2', [chainKey, id])
  return res.rows[0] ? toApproval(res.rows[0]) : null
}

export async function createApproval(chainKey: string, tokenId: number, proposal: Proposal, agentReason: string): Promise<Approval> {
  const db = await getDb()
  const id = randomUUID()
  const res = await db.query<ApprovalRow>(
    'INSERT INTO approvals (id, chain_key, token_id, proposal, agent_reason) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [id, chainKey, tokenId, JSON.stringify(proposal), agentReason],
  )
  return toApproval(res.rows[0])
}

/** 终态更新(executed/failed/rejected);approved 只是中间态,这里一并支持 */
export async function resolveApproval(
  id: string,
  status: Exclude<ApprovalStatus, 'pending'>,
  txHash?: string,
): Promise<void> {
  const db = await getDb()
  await db.query('UPDATE approvals SET status = $1, tx_hash = $2, resolved_at = now() WHERE id = $3', [
    status,
    txHash ?? null,
    id,
  ])
}
