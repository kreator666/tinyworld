// 一次性链上验证脚本:Fuji AVAX/USDT 流动性核实(不入库,不进 git)
import { createPublicClient, http, parseAbi } from 'viem'
import { avalancheFuji } from 'viem/chains'

const rpc = createPublicClient({ chain: avalancheFuji, transport: http('https://api.avax-test.network/ext/bc/C/rpc') })

const WAVAX = '0xd00ae08403B9bbb9124bB305C09058E32C39A48c'
const USDT = '0xAb231A5744C8E6c45481754928cCfFFFD4aa0732'
const USDC = '0x5425890298aed601595a70AB815c96711a31Bc65'
const ROUTER_V1 = '0xd7f655E3376cE2D7A2b08fF01Eb3B1023191A901'
const FACTORY_V1 = '0xF5c7d9733e5f53abCC1695820c4818C59B457C2C'
const PAIR_V1_AVAX_USDT = '0xd30b5a385ea5e48f28924ee642ef6c7883b2f8c6'
const LB_QUOTER_V21 = '0xd76019A16606FDa4651f636D9751f500Ed776250'
const LB_POOL_AVAX_USDT = '0x0c1289b6D5335aae075E8Db2AF43E60E1eB2897E'

const erc20 = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)'])
const routerV1 = parseAbi(['function getAmountsOut(uint256,address[]) view returns (uint256[])', 'function factory() view returns (address)'])
const pairV1 = parseAbi(['function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)', 'function token1() view returns (address)'])
const lbQuoter = parseAbi(['function getSwapOut(address pair, uint128 amountIn, bool swapForY) view returns (uint256 amountOut, bytes32 afterSwap)', 'function getPool(address tokenX, address tokenY, uint24 binStep) view returns (address)'])

const log = (...a: any[]) => console.log(...a)

try {
  log('--- USDT 基本信息 ---')
  const [sym, dec, supply] = await Promise.all([
    rpc.readContract({ address: USDT, abi: erc20, functionName: 'symbol' }),
    rpc.readContract({ address: USDT, abi: erc20, functionName: 'decimals' }),
    rpc.readContract({ address: USDT, abi: erc20, functionName: 'totalSupply' }),
  ])
  log(`symbol=${sym} decimals=${dec} totalSupply=${supply}`)

  log('--- TJ V1: WAVAX/USDT pair 储备 ---')
  const [r0, r1, t0] = await Promise.all([
    rpc.readContract({ address: PAIR_V1_AVAX_USDT, abi: pairV1, functionName: 'getReserves' }),
    null as any,
    rpc.readContract({ address: PAIR_V1_AVAX_USDT, abi: pairV1, functionName: 'token0' }),
  ])
  const [res0, res1, ts] = r0 as any
  log(`token0=${t0} reserve0=${res0} reserve1=${res1} blockTimestamp=${ts}`)
  const avaxRes = (t0 as string).toLowerCase() === WAVAX.toLowerCase() ? res0 : res1
  const usdtRes = (t0 as string).toLowerCase() === WAVAX.toLowerCase() ? res1 : res0
  log(`=> AVAX 储备=${Number(avaxRes) / 1e18}, USDT 储备=${Number(usdtRes) / 1e6}`)

  log('--- TJ V1 router getAmountsOut ---')
  for (const [label, path] of [
    ['1 AVAX -> USDT', [WAVAX, USDT]],
    ['1 AVAX -> USDC', [WAVAX, USDC]],
  ] as any) {
    try {
      const out = await rpc.readContract({ address: ROUTER_V1, abi: routerV1, functionName: 'getAmountsOut', args: [10n ** 18n, path] })
      log(`${label}: ${out}`)
    } catch (e: any) { log(`${label}: REVERT ${e.shortMessage ?? e.message}`) }
  }

  log('--- TJ V2.1 LBQuoter: WAVAX/USDT 官方池(15bps) ---')
  try {
    const out = await rpc.readContract({ address: LB_QUOTER_V21, abi: lbQuoter, functionName: 'getSwapOut', args: [LB_POOL_AVAX_USDT, 10n ** 18n, true] })
    log(`1 AVAX -> USDT (V2.1 quoter): ${out}`)
  } catch (e: any) { log(`V2.1 quoter REVERT: ${e.shortMessage ?? e.message}`) }

  log('--- V2.1 router 版本核对(LBRouter.factory / 池地址 getPool) ---')
  const lbRouter21 = parseAbi(['function factory() view returns (address)'])
  try {
    const f21 = await rpc.readContract({ address: '0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30', abi: lbRouter21, functionName: 'factory' })
    log(`V2.1 router factory=${f21}`)
  } catch (e: any) { log(`V2.1 router factory REVERT: ${e.shortMessage ?? e.message}`) }
} catch (e: any) {
  console.error('FATAL', e)
  process.exit(1)
}
