import { getPublicClient } from '../src/chain/clients'
import { getChainContext } from '../src/chain/registry'
import { formatEther, keccak256, encodeAbiParameters, type Address } from 'viem'

function key(s: string) {
  return keccak256(encodeAbiParameters([{ type: 'string' }], [s]))
}

async function main() {
  const chainKey = 'avalanche'
  const cfg = getChainContext(chainKey).cfg
  if (!cfg.gmx) throw new Error('no gmx cfg')
  const dataStore = cfg.gmx.dataStore as Address
  const client = getPublicClient(chainKey)
  const abi = [{ type: 'function', name: 'getUint', stateMutability: 'view', inputs: [{ name: 'key', type: 'bytes32' }], outputs: [{ name: '', type: 'uint256' }] }] as const

  const keys = [
    'ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1',
    'ESTIMATED_GAS_FEE_PER_ORACLE_PRICE',
    'ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR',
    'INCREASE_ORDER_GAS_LIMIT',
    'DECREASE_ORDER_GAS_LIMIT',
  ] as const

  const vals: Record<string, bigint> = {}
  for (const k of keys) {
    vals[k] = (await client.readContract({ address: dataStore, abi, functionName: 'getUint', args: [key(k)] })) as bigint
    console.log(`${k}:`, vals[k].toString())
  }

  const gasPrice = await client.getGasPrice()
  console.log('gasPrice:', gasPrice.toString())

  const PRECISION = 10n ** 30n
  const oraclePriceCount = 3n
  const baseGasLimit = vals.ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1 + vals.ESTIMATED_GAS_FEE_PER_ORACLE_PRICE * oraclePriceCount

  for (const orderType of ['INCREASE_ORDER_GAS_LIMIT', 'DECREASE_ORDER_GAS_LIMIT'] as const) {
    const estimatedGasLimit = vals[orderType]
    const adjusted = baseGasLimit + (estimatedGasLimit * vals.ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR) / PRECISION
    const minFee = adjusted * gasPrice
    console.log(`${orderType} recommended executionFee:`, formatEther(minFee), 'AVAX')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
