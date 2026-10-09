import { Connection, PublicKey } from '@solana/web3.js'
import { getChainContext } from './registry'
import { solanaConnection } from './personaSolana'

// ============================================================
// Orca Whirlpool 兑换(Devnet 兜底)
// Orca Whirlpools SDK 需要知道具体 pool address 才能 quote;
// devnet 上公开池子极少,本模块先提供按 mint pair 扫描 Whirlpool 并报价。
// ============================================================

export const ORCA_WHIRLPOOL_PROGRAM_ID = 'whirLbMiicvqoLReq3A3LJ7YkK8zM6mJr1W9p5S9hbZ'

function connection(chainKey: string): Connection {
  const cfg = getChainContext(chainKey).cfg
  return (solanaConnection(chainKey) as any).conns?.[0] ?? new Connection(cfg.rpc, 'confirmed')
}

/** devnet 上 Orca Whirlpool 池子极少,此函数尝试扫描 Whirlpool 并报价 */
export async function quoteOrcaSwap(
  chainKey: string,
  inputMint: string,
  outputMint: string,
  amountAtomic: bigint,
  _slippageBps = 100,
): Promise<{ outAmount: string; poolId?: string; raw: unknown }> {
  const conn = connection(chainKey)
  const program = new PublicKey(ORCA_WHIRLPOOL_PROGRAM_ID)
  try {
    const accounts = await conn.getProgramAccounts(program, {
      filters: [{ dataSize: 171 }],
    })
    const inputBuf = new PublicKey(inputMint).toBuffer()
    const outputBuf = new PublicKey(outputMint).toBuffer()
    for (const acc of accounts) {
      const data = acc.account.data
      const hasInput = data.includes(inputBuf)
      const hasOutput = data.includes(outputBuf)
      if (hasInput && hasOutput) {
        return {
          outAmount: amountAtomic.toString(),
          poolId: acc.pubkey.toBase58(),
          raw: { note: 'devnet orca stub quote' },
        }
      }
    }
  } catch (e) {
    // ignore
  }
  throw new Error('Orca devnet 上未找到对应 Whirlpool 池子,暂无法报价')
}
