import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { formatEther, type Address } from 'viem'
import { getChainContext } from '../../../src/chain/registry'
import { getGmxWalletAddress, getMarkets, getAccountPositions, getPositionsByMarket, type GmxPosition } from '../../../src/chain/gmx'
import { getSwapMode } from '../../../src/core/settings'
import { loadPersona } from '../../../src/chain/persona'
import { getNativePriceUsd } from '../../../src/core/price'
import type { SkillDef } from '../../../src/skills/registry'

// ============================================================
// 内置技能 defi-perp-gmx:GMX V2 永续/现货(只读)
// - gmx_markets:列出该链所有 GMX 市场
// - gmx_position:查询用户在某市场的仓位
// - gmx_price:查询某市场的标记价格(目前用 CoinGecko 行情估算)
// v0.1 只读;v0.2 计划开放 propose_gmx_order 下单
// ============================================================

function fmtAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function fmtUsd(v: bigint, decimals = 30): string {
  // GMX V2 内部 USD 精度为 30
  const s = v.toString().padStart(decimals + 1, '0')
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, '')
}

/** gmx_markets:列出所有市场 */
function makeGmxMarkets(chainKey: string) {
  return createTool({
    id: 'gmx_markets',
    description: '查询当前链上所有 GMX V2 市场,返回市场代币、指数代币、多空抵押代币地址。只读。',
    inputSchema: z.object({}),
    outputSchema: z.object({
      summary: z.string(),
      markets: z.array(
        z.object({
          marketToken: z.string(),
          indexToken: z.string(),
          longToken: z.string(),
          shortToken: z.string(),
        }),
      ),
      error: z.string().optional(),
    }),
    execute: async () => {
      try {
        const cfg = getChainContext(chainKey).cfg
        if (!cfg.gmx) return { summary: '', markets: [], error: `链 ${cfg.name} 未配置 GMX V2` }
        const markets = await getMarkets(chainKey)
        const summary = `链 ${cfg.name} 共有 ${markets.length} 个 GMX V2 市场`
        return {
          summary,
          markets: markets.map((m) => ({
            marketToken: m.marketToken,
            indexToken: m.indexToken,
            longToken: m.longToken,
            shortToken: m.shortToken,
          })),
        }
      } catch (err) {
        return { summary: '', markets: [], error: err instanceof Error ? err.message : String(err) }
      }
    },
  })
}

/** gmx_position:查询用户在某市场的仓位 */
function makeGmxPosition(chainKey: string, tokenId: number) {
  return createTool({
    id: 'gmx_position',
    description:
      '查询用户在 GMX V2 某市场的永续仓位。可指定 marketToken(完整地址)或 symbol(如 "AVAX","ETH","BTC");不指定则返回所有市场仓位。只读。',
    inputSchema: z.object({
      marketToken: z.string().optional().describe('GMX 市场代币地址(完整 0x 地址);与 symbol 二选一'),
      symbol: z.string().optional().describe('指数代币符号,如 "AVAX","ETH","BTC";与 marketToken 二选一'),
    }),
    outputSchema: z.object({
      summary: z.string(),
      positions: z.array(
        z.object({
          market: z.string(),
          side: z.string(),
          sizeUsd: z.string(),
          collateralToken: z.string(),
          collateralAmount: z.string(),
          increasedAt: z.string(),
        }),
      ),
      error: z.string().optional(),
    }),
    execute: async ({ context }) => {
      try {
        const cfg = getChainContext(chainKey).cfg
        if (!cfg.gmx) return { summary: '', positions: [], error: `链 ${cfg.name} 未配置 GMX V2` }

        const mode = await getSwapMode(chainKey, tokenId)
        const account =
          mode === 'user_wallet'
            ? ((await loadPersona(chainKey, tokenId)).owner as Address)
            : (getGmxWalletAddress() ?? '0x0000000000000000000000000000000000000000')
        if (!account || account === '0x0000000000000000000000000000000000000000') {
          return { summary: '', positions: [], error: '未配置执行密钥或无法确定 owner' }
        }

        let positions: GmxPosition[]
        if (context.marketToken) {
          positions = await getPositionsByMarket(chainKey, account, context.marketToken as Address)
        } else {
          positions = await getAccountPositions(chainKey, account)
          if (context.symbol) {
            // 按 indexToken 符号过滤:先读市场列表,匹配 symbol 后再过滤
            const markets = await getMarkets(chainKey)
            const symLower = context.symbol.toLowerCase()
            const matched = markets.filter((m) => {
              // 简单启发式:地址中包含 symbol 子串(非严谨,仅辅助)
              // 更严谨应读 ERC20 symbol,这里先保持只读不额外发请求
              return m.indexToken.toLowerCase().includes(symLower)
            })
            const marketSet = new Set(matched.map((m) => m.marketToken.toLowerCase()))
            positions = positions.filter((p) => marketSet.has(p.market.toLowerCase()))
          }
        }

        const summary = `共 ${positions.length} 个仓位`
        return {
          summary,
          positions: positions.map((p) => ({
            market: p.market,
            side: p.isLong ? 'LONG' : 'SHORT',
            sizeUsd: fmtUsd(p.sizeInUsd),
            collateralToken: p.collateralToken,
            collateralAmount: p.collateralAmount.toString(),
            increasedAt: new Date(Number(p.increasedAtTime) * 1000).toISOString(),
          })),
        }
      } catch (err) {
        return { summary: '', positions: [], error: err instanceof Error ? err.message : String(err) }
      }
    },
  })
}

/** gmx_price:查询某市场 indexToken 的当前价格(先用原生币行情源兜底,后续可接 GMX Oracle) */
function makeGmxPrice(chainKey: string) {
  return createTool({
    id: 'gmx_price',
    description:
      '查询 GMX V2 某市场的指数代币当前价格。目前先用 CoinGecko/Gate 行情源估算(USD),后续接入 GMX Oracle 后会更精准。只读。',
    inputSchema: z.object({
      symbol: z.string().describe('指数代币符号,如 "AVAX","ETH","BTC"'),
    }),
    outputSchema: z.object({
      symbol: z.string(),
      priceUsd: z.number(),
      source: z.string(),
      note: z.string(),
      error: z.string().optional(),
    }),
    execute: async ({ context }) => {
      try {
        const sym = context.symbol.toUpperCase()
        // 目前只支持原生币(AVAX)或已配置的行情币;其他符号提示暂不支持
        if (sym === 'AVAX') {
          const { usd } = await getNativePriceUsd(chainKey)
          return { symbol: sym, priceUsd: usd, source: 'CoinGecko/Gate native', note: 'AVAX/USD 价格' }
        }
        return {
          symbol: sym,
          priceUsd: 0,
          source: 'none',
          note: `暂不支持 ${sym} 的价格查询,请先用外部行情源。后续将接入 GMX Oracle。`,
        }
      } catch (err) {
        return {
          symbol: context.symbol.toUpperCase(),
          priceUsd: 0,
          source: 'error',
          note: '',
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
  })
}

export const defiPerpGmx: SkillDef = {
  manifest: {
    id: 'defi-perp-gmx',
    name: 'GMX V2 永续交易',
    version: '0.1.0',
    description:
      'GMX V2 去中心化永续/现货交易:查询市场、查询仓位、标记价格(只读)。下单功能后续开放。支持多链,当前已配置 Avalanche/Arbitrum。',
    tools: ['gmx_markets', 'gmx_position', 'gmx_price'],
    permissions: ['defi'],
    scope: 'owner',
    evmOnly: true,
    protocol: 'gmx-perp',
    protocolRequired: true,
  },
  makeTools: (chainKey, tokenId) => ({
    gmx_markets: makeGmxMarkets(chainKey),
    gmx_position: makeGmxPosition(chainKey, tokenId),
    gmx_price: makeGmxPrice(chainKey),
  }),
}
