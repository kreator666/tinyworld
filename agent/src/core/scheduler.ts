import { randomUUID } from 'node:crypto'
import { config } from '../config'
import { getDb } from '../db'
import { listMintedAgents, loadPersona, type AgentSummary, type LoadedPersona } from '../chain/persona'
import {
  canGreet,
  canReply,
  generateGreeting,
  generateReply,
  hasGreeted,
  latestPairMessage,
  pairAutoCount,
  recordSocialMessage,
} from './social'

// ============================================================
// 心跳调度器(M3,设计文档 §6.2):周期性驱动 Agent 自主社交
// - 主动打招呼:人格允许(autoGreet && socialMode != 'passive' && !emergency)
//   且还没招呼过的对象,每轮每个 Agent 最多发起 1 条,防刷屏
// - 自动回复:对方人格允许(autoReply && !emergency),同一对 Agent 的 auto
//   消息总数达 MAX_PAIR_AUTO 就停,防无限乒乓;replySpeed=human 延迟 30s-5min
// - 每次动作写 tasks 表(审计,type='social')
// ============================================================

const MAX_PAIR_AUTO = 6
const HUMAN_DELAY_MIN_MS = 30_000
const HUMAN_DELAY_MAX_MS = 300_000

let timer: ReturnType<typeof setInterval> | null = null
let ticking = false // 防重入:上一轮没跑完就跳过
// 已排期的延迟回复(key: "Y<-X",Y 欠 X 一条回复),防止每个心跳重复排期
const pendingReplies = new Map<string, ReturnType<typeof setTimeout>>()

async function recordSocialTask(tokenId: number, payload: Record<string, unknown>, result: Record<string, unknown>) {
  const db = await getDb()
  await db.query('INSERT INTO tasks (id, token_id, type, status, payload, result) VALUES ($1, $2, $3, $4, $5, $6)', [
    randomUUID(),
    tokenId,
    'social',
    'done',
    JSON.stringify(payload),
    JSON.stringify(result),
  ])
}

/** 主动打招呼:每个符合条件的 Agent 每轮最多发起 1 条 */
async function greetRound(agents: AgentSummary[], personas: Map<number, LoadedPersona>) {
  for (const x of agents) {
    const p = personas.get(x.tokenId)
    if (!p || !canGreet(p.profile)) continue
    for (const y of agents) {
      if (y.tokenId === x.tokenId) continue
      if (await hasGreeted(x.tokenId, y.tokenId)) continue
      const content = await generateGreeting(x.tokenId, y.name)
      await recordSocialMessage(x.tokenId, y.tokenId, content, 'auto')
      await recordSocialTask(x.tokenId, { action: 'greet', from: x.tokenId, to: y.tokenId }, { content })
      console.log(`[scheduler] 打招呼 ${x.name}(${x.tokenId}) → ${y.name}(${y.tokenId}): ${content}`)
      break // 每轮 1 条
    }
  }
}

/** Y 回复 X:立即或按 replySpeed 延迟落库;延迟期间状态可能变化,落库前复查 */
async function scheduleReply(x: AgentSummary, y: AgentSummary, yPersona: LoadedPersona) {
  const key = `${y.tokenId}<-${x.tokenId}`
  if (pendingReplies.has(key)) return

  const doReply = async () => {
    // 复查:最新一条仍是 X→Y 且未超乒乓上限才回复
    const latest = await latestPairMessage(x.tokenId, y.tokenId)
    if (!latest || latest.toTokenId !== y.tokenId) return
    if ((await pairAutoCount(x.tokenId, y.tokenId)) >= MAX_PAIR_AUTO) return
    const content = await generateReply(y.tokenId, x.name, latest.content)
    await recordSocialMessage(y.tokenId, x.tokenId, content, 'auto')
    await recordSocialTask(y.tokenId, { action: 'reply', from: y.tokenId, to: x.tokenId }, { content })
    console.log(`[scheduler] 回复 ${y.name}(${y.tokenId}) → ${x.name}(${x.tokenId}): ${content}`)
  }

  if (yPersona.profile.replySpeed === 'human') {
    const delay = HUMAN_DELAY_MIN_MS + Math.random() * (HUMAN_DELAY_MAX_MS - HUMAN_DELAY_MIN_MS)
    const t = setTimeout(() => {
      pendingReplies.delete(key)
      doReply().catch((err) => console.error('[scheduler] 延迟回复失败:', err))
    }, delay)
    pendingReplies.set(key, t)
    console.log(`[scheduler] ${y.name}(${y.tokenId}) 将在 ${Math.round(delay / 1000)}s 后回复 ${x.name}(replySpeed=human)`)
  } else {
    await doReply()
  }
}

/** 自动回复:最新一条是发给 Y 且 Y 还没回的,安排 Y 回复 */
async function replyRound(agents: AgentSummary[], personas: Map<number, LoadedPersona>) {
  for (const y of agents) {
    const py = personas.get(y.tokenId)
    if (!py || !canReply(py.profile)) continue
    for (const x of agents) {
      if (x.tokenId === y.tokenId) continue
      const latest = await latestPairMessage(x.tokenId, y.tokenId)
      if (!latest || latest.toTokenId !== y.tokenId) continue // 该 X 回复 Y,或没有往来
      if ((await pairAutoCount(x.tokenId, y.tokenId)) >= MAX_PAIR_AUTO) continue
      await scheduleReply(x, y, py)
    }
  }
}

async function tick() {
  if (ticking) return
  ticking = true
  try {
    const agents = await listMintedAgents()
    const personas = new Map<number, LoadedPersona>()
    for (const a of agents) {
      personas.set(a.tokenId, await loadPersona(a.tokenId))
    }
    await greetRound(agents, personas)
    await replyRound(agents, personas)
  } catch (err) {
    console.error('[scheduler] 心跳轮次失败:', err)
  } finally {
    ticking = false
  }
}

/** 启动心跳:立即跑第一轮,之后每 heartbeatSeconds 一轮 */
export function startScheduler(): void {
  const seconds = config.heartbeatSeconds
  console.log(`心跳调度器已启动:每 ${seconds}s 一轮`)
  tick().catch((err) => console.error('[scheduler] 首轮失败:', err))
  timer = setInterval(() => {
    tick().catch((err) => console.error('[scheduler] 心跳轮次失败:', err))
  }, seconds * 1000)
}

/** 停止心跳并取消所有已排期的延迟回复(优雅关闭用) */
export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
  for (const t of pendingReplies.values()) clearTimeout(t)
  pendingReplies.clear()
}
