import { getChainContext } from '../src/chain/registry'
import { evaluateProposal, type Proposal } from '../src/policy/engine'
import { getDb, initSchema } from '../src/db'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = path.resolve(process.cwd(), 'data-test-aave-policy-' + randomUUID())
process.env.AGENT_DATA_DIR = DATA_DIR

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  await initSchema()
  const chainKey = 'avalanche'
  const ctx = getChainContext(chainKey)
  const cfg = ctx.cfg
  if (!cfg.aave?.assets) throw new Error('missing aave.assets')

  const pool = cfg.aave.pool
  const router = cfg.defi!.router

  const testCases: Array<{ name: string; proposal: Proposal; expect: 'execute' | 'rejected' }> = []

  // lending assets should be allowed
  for (const asset of cfg.aave.assets) {
    const amount = (10n ** BigInt(asset.decimals)).toString()
    testCases.push({
      name: `supply ${asset.symbol}`,
      proposal: {
        action: 'supply',
        protocol: pool,
        chainId: cfg.chainId,
        executionMode: 'hot_wallet',
        params: { tokenIn: asset.address, tokenOut: `aToken(${asset.symbol})`, amountIn: amount },
        estimatedValueUsd: 10,
        reason: 'test',
      },
      expect: 'execute',
    })
    testCases.push({
      name: `withdraw ${asset.symbol}`,
      proposal: {
        action: 'withdraw',
        protocol: pool,
        chainId: cfg.chainId,
        executionMode: 'hot_wallet',
        params: { tokenIn: asset.address, tokenOut: asset.address, amountIn: amount },
        estimatedValueUsd: 10,
        reason: 'test',
      },
      expect: 'execute',
    })
  }

  // swap should still only allow base tokens
  testCases.push({
    name: 'swap WAVAX→USDC allowed',
    proposal: {
      action: 'swap',
      protocol: router,
      chainId: cfg.chainId,
      executionMode: 'hot_wallet',
      params: { tokenIn: cfg.defi!.wNative, tokenOut: cfg.defi!.usdc, amountIn: '1000000000000000' },
      estimatedValueUsd: 10,
      reason: 'test',
    },
    expect: 'execute',
  })

  // BTC.b should NOT be allowed in swap
  const btcB = cfg.aave.assets.find((a) => a.symbol === 'BTC.b')!
  testCases.push({
    name: 'swap BTC.b→USDC rejected',
    proposal: {
      action: 'swap',
      protocol: router,
      chainId: cfg.chainId,
      executionMode: 'hot_wallet',
      params: { tokenIn: btcB.address, tokenOut: cfg.defi!.usdc, amountIn: '1000000' },
      estimatedValueUsd: 10,
      reason: 'test',
    },
    expect: 'rejected',
  })

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
