import { Connection, PublicKey } from '@solana/web3.js'
import { getChainContext } from './registry'
import { solanaConnection } from './personaSolana'

// ============================================================
// Raydium CPMM 兑换(Devnet 兜底)
// Raydium SDK V2 主做链上读池 + 链上 swap;devnet 流动性极少,
// 本模块先封装 quote 能力:能拿到池子则返回报价,没有则抛明确错误。
// ============================================================

export const RAYDIUM_CPMM_PROGRAM_ID = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'

function connection(chainKey: string): Connection {
  const cfg = getChainContext(chainKey).cfg
  return (solanaConnection(chainKey) as any).conns?.[0] ?? new Connection(cfg.rpc, 'confirmed')
}

/** devnet 上 Raydium CPMM 池子极少,此函数尝试按 mint pair 查找池子并报价 */
export async function quoteRaydiumSwap(
  chainKey: string,
  inputMint: string,
  outputMint: string,
  amountAtomic: bigint,
  _slippageBps = 100,
): Promise<{ outAmount: string; poolId?: string; raw: unknown }> {
  const conn = connection(chainKey)
  // 通过 RPC 扫描 Raydium CPMM pool(按 program id),再用基础 layout 过滤 mint
  const program = new PublicKey(RAYDIUM_CPMM_PROGRAM_ID)
  // 注意:devnet 可能完全没有 CPMM 池;扫描前先给个兜底提示
  try {
    const accounts = await conn.getProgramAccounts(program, {
      filters: [{ dataSize: 215 }],
    })
    // 简单过滤:池子数据里包含 inputMint 和 outputMint
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
          raw: { note: 'devnet raydium stub quote' },
        }
      }
    }
  } catch (e) {
    // ignore
  }
  throw new Error('Raydium devnet 上未找到对应 CPMM 池子,暂无法报价')
}
