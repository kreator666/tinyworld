import { getChainContext } from '../src/chain/registry'
import { fetchUnlockPeriods, fetchUnlockRequests } from '../src/chain/benqi'

// 只读验证:BENQI 赎回 ticket 查询
async function main() {
  const chainKey = 'avalanche'
  const ctx = getChainContext(chainKey)
  if (!ctx.cfg.benqi) {
    console.error('avalanche 未配置 BENQI')
    process.exit(1)
  }

  console.log('BENQI staking:', ctx.cfg.benqi.staking)
  console.log('BENQI sAVAX:', ctx.cfg.benqi.sAvax)

  const periods = await fetchUnlockPeriods(chainKey)
  console.log('cooldownPeriod(s):', periods.cooldownSeconds.toString())
  console.log('redeemPeriod(s):', periods.redeemSeconds.toString())

  // 查零地址,应返回空数组
  const zero = '0x0000000000000000000000000000000000000000' as `0x${string}`
  const empty = await fetchUnlockRequests(chainKey, zero)
  console.log('zero address requests:', empty.length)

  // 查一个可能有钱的地址(示例,可能没赎回记录)
  const sample = '0x784D68dB62448cDeBC5599ba7f8b2FbB59174018' as `0x${string}`
  const requests = await fetchUnlockRequests(chainKey, sample)
  console.log('sample address requests:', requests.length)
  for (const r of requests.slice(0, 5)) {
    console.log('  #', r.index, 'shares:', r.shareAmount.toString(), 'status:', r.status, 'claimableAt:', r.claimableAt.toISOString())
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
