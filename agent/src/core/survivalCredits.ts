import { config } from '../config'
import { getDb } from '../db'
import { insertLedger } from '../db/survival'

// ============================================================
// 生存模式 credits 账本(USD 计价,账本服):
// - burnCredits:原子扣减(UPDATE ... WHERE credits_usd >= cost),余额不足返回 false
// - topupCredits:admin 人工充值(真实 NEAR AI 充值由人操作,这里只记账)
// - 定价:NEAR AI /v1/models 拉取模型单价(5min TTL),失败回落固定 $0.001
// - healConvert:宠物 yield_yocto 按 NEAR 价折算记入 credits(治疗动作的"打工换钱")
// ============================================================

/** 两位小数展示的计费精度(计算用 number,落库 NUMERIC(20,6)) */
function round6(usd: number): string {
  return usd.toFixed(6)
}

// ------------------------------------------------------------------
// 原子扣减 / 充值
// ------------------------------------------------------------------

/** 原子扣 credits:余额充足才扣并写账本(credit_burn);不足返回 false 不产生任何写入 */
export async function burnCredits(chainKey: string, tokenId: number, usdCost: number, note: string): Promise<boolean> {
  if (!(usdCost > 0)) return true // 零成本直接成功
  const db = await getDb()
  const res = await db.query<{ credits_usd: string }>(
    `UPDATE survival_pets
       SET credits_usd = credits_usd - $3::numeric,
           credits_burned_usd = credits_burned_usd + $3::numeric,
           updated_at = now()
     WHERE chain_key = $1 AND token_id = $2 AND credits_usd >= $3::numeric
     RETURNING credits_usd::text AS credits_usd`,
    [chainKey, tokenId, round6(usdCost)],
  )
  const row = res.rows[0]
  if (!row) return false
  await insertLedger({
    chain_key: chainKey, token_id: String(tokenId), kind: 'credit_burn',
    amount_yocto: '0', credits_delta: round6(-usdCost), tx_hash: '', note, ts: Math.floor(Date.now() / 1000),
  })
  return true
}

/** 充值 credits(admin 人工/系统),写账本(topup)并返回最新余额字符串 */
export async function topupCredits(chainKey: string, tokenId: number, usd: number, note: string): Promise<string> {
  if (!(usd > 0)) throw new Error('充值金额必须大于 0')
  const db = await getDb()
  const res = await db.query<{ credits_usd: string }>(
    `UPDATE survival_pets
       SET credits_usd = credits_usd + $3::numeric, updated_at = now()
     WHERE chain_key = $1 AND token_id = $2
     RETURNING credits_usd::text AS credits_usd`,
    [chainKey, tokenId, round6(usd)],
  )
  const row = res.rows[0]
  if (!row) throw new Error(`宠物不存在(chain=${chainKey}, token=${tokenId})`)
  await insertLedger({
    chain_key: chainKey, token_id: String(tokenId), kind: 'topup',
    amount_yocto: '0', credits_delta: round6(usd), tx_hash: '', note, ts: Math.floor(Date.now() / 1000),
  })
  return row.credits_usd
}

// ------------------------------------------------------------------
// NEAR AI 模型定价(5min TTL 缓存)
// ------------------------------------------------------------------

export interface ModelPricing { promptPerToken: number; completionPerToken: number } // USD / token

let pricingCache: { at: number; pricing: ModelPricing | null } = { at: 0, pricing: null }
const PRICING_TTL_MS = 5 * 60_000
const FALLBACK_ESTIMATE_USD = 0.001 // 定价拉取失败时的决策成本估算
/** 预估单次决策的 token 用量(输入:状态+协议模板+近期记录;输出:JSON plan) */
const ESTIMATE_INPUT_TOKENS = 2000
const ESTIMATE_OUTPUT_TOKENS = 500

interface NearaiModelEntry { id?: string; pricing?: { prompt?: string; completion?: string } }

async function fetchPricing(): Promise<ModelPricing | null> {
  if (Date.now() - pricingCache.at < PRICING_TTL_MS) return pricingCache.pricing
  let pricing: ModelPricing | null = null
  try {
    const res = await fetch(`${config.survivalNearaiBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.survivalLlmApiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const data = (await res.json()) as { data?: NearaiModelEntry[] }
      const entry = data.data?.find((m) => m.id === config.survivalLlmModel)
      const prompt = Number(entry?.pricing?.prompt)
      const completion = Number(entry?.pricing?.completion)
      if (Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0) {
        pricing = { promptPerToken: prompt, completionPerToken: completion }
      }
    }
  } catch {
    pricing = null // 网络失败回落固定估算
  }
  pricingCache = { at: Date.now(), pricing }
  return pricing
}

/** 单次决策估算成本(USD);定价源不可用时回落固定 $0.001 */
export async function estimateDecisionCostUsd(): Promise<number> {
  const pricing = await fetchPricing()
  if (!pricing) return FALLBACK_ESTIMATE_USD
  return pricing.promptPerToken * ESTIMATE_INPUT_TOKENS + pricing.completionPerToken * ESTIMATE_OUTPUT_TOKENS
}

/**
 * NEAR AI 实时定价探测(heal 折算前调用):在线返回 glm 等模型的 prompt/completion 单价(USD/token),
 * 不可达返回 null(调用方按回落价折算,不阻塞)。5min TTL 缓存,与计费同源。
 */
export async function nearAiLivePricing(): Promise<ModelPricing | null> {
  return fetchPricing()
}

/** 按实际 token 用量计费(USD);定价源不可用时回落固定 $0.001 */
export async function actualCostUsd(inputTokens: number, outputTokens: number): Promise<number> {
  const pricing = await fetchPricing()
  if (!pricing) return FALLBACK_ESTIMATE_USD
  return pricing.promptPerToken * inputTokens + pricing.completionPerToken * outputTokens
}

// ------------------------------------------------------------------
// NEAR 价格(heal 折算用):CoinGecko 'near',失败用上次缓存,再无则固定 2.5
// ------------------------------------------------------------------

const NEAR_PRICE_FALLBACK = 2.5
let nearPriceCache: { at: number; usd: number } | null = null

export async function nearPriceUsd(): Promise<number> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd', {
      signal: AbortSignal.timeout(8_000),
    })
    if (res.ok) {
      const data = (await res.json()) as { near?: { usd?: number } }
      const usd = data.near?.usd
      if (typeof usd === 'number' && usd > 0) {
        nearPriceCache = { at: Date.now(), usd }
        return usd
      }
    }
    throw new Error('CoinGecko 返回缺少 near 价格')
  } catch {
    if (nearPriceCache) return nearPriceCache.usd
    return NEAR_PRICE_FALLBACK
  }
}

// ------------------------------------------------------------------
// heal 折算:yield_yocto → credits_usd(清空 yield,按 NEAR 价记入 credits)
// ------------------------------------------------------------------

export async function healConvert(chainKey: string, tokenId: number): Promise<{ convertedUsd: number; yieldBefore: string }> {
  const db = await getDb()
  const res = await db.query<{ yield_yocto: string }>(
    `UPDATE survival_pets
       SET yield_yocto = 0, updated_at = now()
     WHERE chain_key = $1 AND token_id = $2
     RETURNING yield_yocto::text AS yield_yocto`,
    [chainKey, tokenId],
  )
  const row = res.rows[0]
  if (!row) throw new Error(`宠物不存在(chain=${chainKey}, token=${tokenId})`)
  const yieldBefore = row.yield_yocto
  const yocto = BigInt(yieldBefore || '0')
  if (yocto <= 0n) return { convertedUsd: 0, yieldBefore }
  const usd = (Number(yocto) / 1e24) * (await nearPriceUsd())
  if (usd > 0) {
    await topupCredits(chainKey, tokenId, usd, 'heal-convert')
    // topup 记的是 topup 账本;补一条 yield 出账留痕,保持 yield 池对账平衡
    await insertLedger({
      chain_key: chainKey, token_id: String(tokenId), kind: 'yield',
      amount_yocto: (-yocto).toString(), credits_delta: '0', tx_hash: '',
      note: 'heal-convert: 收益折算为 credits', ts: Math.floor(Date.now() / 1000),
    })
  }
  return { convertedUsd: usd, yieldBefore }
}
