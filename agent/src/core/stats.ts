import { getDb } from '../db'

// ============================================================
// Agent 统计(M3/M4):个人主页「Agent 活跃度 / 社交互动数」的真实数据来源
// - 社交互动数:social_messages 中该 Agent 发出 + 收到的消息总数
// - 活跃度:近 7 天内有链上/社交/对话活动的天数占比(0-100)
// ============================================================

export interface AgentStats {
  socialInteractions: number
  /** 近 7 天活跃天数(有任意活动记一天) */
  activeDays7d: number
  /** 活跃度百分比 0-100(= activeDays7d / 7 * 100,封顶 100) */
  activityPercent: number
}

/** 该 Agent 发出 + 收到的社交消息总数 */
async function countSocialInteractions(tokenId: number): Promise<number> {
  const db = await getDb()
  const res = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM social_messages WHERE from_token_id = $1 OR to_token_id = $1`,
    [tokenId],
  )
  return Number(res.rows[0]?.n ?? 0)
}

/** 近 7 天活跃天数:tasks(链上任务)+ social_messages(社交)+ 助手对话消息 任意有记录即算活跃 */
async function countActiveDays(tokenId: number, days = 7): Promise<number> {
  const db = await getDb()
  const res = await db.query<{ d: string }>(
    `SELECT COUNT(DISTINCT d)::text AS d FROM (
       SELECT created_at::date AS d FROM tasks
        WHERE token_id = $1 AND created_at > now() - make_interval(days => $2)
       UNION
       SELECT created_at::date FROM social_messages
        WHERE (from_token_id = $1 OR to_token_id = $1) AND created_at > now() - make_interval(days => $2)
       UNION
       SELECT m.created_at::date FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.token_id = $1 AND m.created_at > now() - make_interval(days => $2)
     ) t`,
    [tokenId, days],
  )
  return Number(res.rows[0]?.d ?? 0)
}

export async function getAgentStats(tokenId: number): Promise<AgentStats> {
  const [socialInteractions, activeDays7d] = await Promise.all([
    countSocialInteractions(tokenId),
    countActiveDays(tokenId, 7),
  ])
  return {
    socialInteractions,
    activeDays7d,
    activityPercent: Math.min(100, Math.round((activeDays7d / 7) * 100)),
  }
}
