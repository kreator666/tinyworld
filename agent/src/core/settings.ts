import { getDb } from '../db'

// ============================================================
// Agent 级设置(M4):兑换执行模式等可由主人调整的开关
// ============================================================

export type SwapMode = 'hot_wallet' | 'user_wallet'

export interface AgentSettingsRow {
  token_id: number
  swap_mode: SwapMode
  updated_at: string
}

export async function getSwapMode(chainKey: string, tokenId: number): Promise<SwapMode> {
  const db = await getDb()
  const res = await db.query<AgentSettingsRow>('SELECT swap_mode FROM agent_settings WHERE chain_key = $1 AND token_id = $2', [chainKey, tokenId])
  // 默认使用用户钱包签名模式:更符合"Agent 帮你组装、你亲自授权"的安全直觉,
  // 也能确保浏览器插件钱包会被唤起。如需自动执行,主人可在个人主页切换为热钱包。
  return res.rows[0]?.swap_mode ?? 'user_wallet'
}

export async function setSwapMode(chainKey: string, tokenId: number, mode: SwapMode): Promise<void> {
  const db = await getDb()
  await db.query(
    `INSERT INTO agent_settings (chain_key, token_id, swap_mode) VALUES ($1, $2, $3)
     ON CONFLICT (chain_key, token_id) DO UPDATE SET swap_mode = EXCLUDED.swap_mode, updated_at = now()`,
    [chainKey, tokenId, mode],
  )
}
