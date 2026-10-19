import { getChainContext } from '../src/chain/registry'
import { evaluateProposal, type Proposal } from '../src/policy/engine'
import { getDb, initSchema } from '../src/db'
import { getMarketsWithMeta } from '../src/chain/gmx'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = path.resolve(process.cwd(), 'data-test-gmx-policy-' + randomUUID())
process.env.AGENT_DATA_DIR = DATA_DIR

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  await initSchema()
  const chainKey = 'avalanche'
  const cfg = getChainContext(chainKey).cfg
  if (!cfg.gmx) throw new Error('Avalanche 未配置 GMX V2')

  const exchangeRouter = cfg.gmx.exchangeRouter
  const markets = await getMarketsWithMeta(chainKey)
  const perp = markets.find((m) => m.indexToken.toLowerCase() !== '0x0000000000000000000000000000000000000000')
  if (!perp) throw new Error('未找到永续市场')

  const randomToken = '0x1111111111111111111111111111111111111111'
  const randomProtocol = '0x2222222222222222222222222222222222222222'

  const testCases: Array<{ name: string; proposal: Proposal; expect: 'execute' | 'rejected' }> = [
    {
      name: `gmx_order ${perp.longSymbol} allowed`,
      proposal: {
        action: 'gmx_order',
        protocol: exchangeRouter,
        chainId: cfg.chainId,
        executionMode: 'hot_wallet',
        params: {
          tokenIn: perp.longToken,
          tokenOut: perp.indexSymbol,
          amountIn: '100000000000000000',
        },
        estimatedValueUsd: 10,
        reason: 'test',
      },
      expect: 'execute',
    },
    {
      name: `gmx_order ${perp.shortSymbol} allowed`,
      proposal: {
        action: 'gmx_order',
        protocol: exchangeRouter,
        chainId: cfg.chainId,
        executionMode: 'hot_wallet',
        params: {
          tokenIn: perp.shortToken,
          tokenOut: perp.indexSymbol,
          amountIn: '1000000',
        },
        estimatedValueUsd: 10,
        reason: 'test',
      },
      expect: 'execute',
    },
    {
      name: 'gmx_order random token rejected',
      proposal: {
        action: 'gmx_order',
        protocol: exchangeRouter,
        chainId: cfg.chainId,
        executionMode: 'hot_wallet',
        params: {
          tokenIn: randomToken,
          tokenOut: perp.indexSymbol,
          amountIn: '1000000',
        },
        estimatedValueUsd: 10,
        reason: 'test',
      },
      expect: 'rejected',
    },
    {
      name: 'gmx_order random protocol rejected',
      proposal: {
        action: 'gmx_order',
        protocol: randomProtocol,
        chainId: cfg.chainId,
        executionMode: 'hot_wallet',
        params: {
          tokenIn: perp.longToken,
          tokenOut: perp.indexSymbol,
          amountIn: '1000000',
        },
        estimatedValueUsd: 10,
        reason: 'test',
      },
      expect: 'rejected',
    },
  ]

  let passed = 0
  for (const tc of testCases) {
    const verdict = await evaluateProposal(chainKey, tc.proposal)
    const ok = verdict.verdict === tc.expect
    console.log(`${ok ? 'PASS' : 'FAIL'} ${tc.name}: ${verdict.verdict} ${!ok ? JSON.stringify(verdict.reasons) : ''}`)
    if (ok) passed++
  }

  console.log(`\n${passed}/${testCases.length} passed`)

  await (await getDb()).close()
  fs.rmSync(DATA_DIR, { recursive: true, force: true })

  if (passed !== testCases.length) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
