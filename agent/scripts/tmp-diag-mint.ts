// 临时诊断:从热钱包真实调用 mint_identity,验证测试网合约铸造链路(用完即删)
import { nearCall } from '../src/chain/nearWrite'

async function main() {
  const name = `diagprobe${Math.floor(Math.random() * 100000)}`
  const out = await nearCall('near-testnet', 'tinyworld.testnet', 'mint_identity', { name }, '0')
  console.log('TX:', JSON.stringify(out))
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
