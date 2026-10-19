import { getChainContext } from '../src/chain/registry'
import { getPublicClient } from '../src/chain/clients'
import { formatUnits, type Address } from 'viem'

// 读取 Avalanche 主网 Aave v3 所有储备资产及其流动性
async function main() {
  const chainKey = 'avalanche'
  const ctx = getChainContext(chainKey)
  if (!ctx.cfg.aave) {
    console.error('avalanche 未配置 Aave')
    process.exit(1)
  }

  const pool = ctx.cfg.aave.pool
  const client = getPublicClient(chainKey)

  const poolAbi = [
    {
      type: 'function',
      name: 'getReservesList',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'address[]' }],
    },
    {
      type: 'function',
      name: 'getReserveData',
      stateMutability: 'view',
      inputs: [{ name: 'asset', type: 'address' }],
      outputs: [
        {
          type: 'tuple',
          components: [
            { name: 'configuration', type: 'tuple', components: [{ name: 'data', type: 'uint256' }] },
            { name: 'liquidityIndex', type: 'uint128' },
            { name: 'currentLiquidityRate', type: 'uint128' },
            { name: 'variableBorrowIndex', type: 'uint128' },
            { name: 'currentVariableBorrowRate', type: 'uint128' },
            { name: 'currentStableBorrowRate', type: 'uint128' },
            { name: 'lastUpdateTimestamp', type: 'uint40' },
            { name: 'id', type: 'uint16' },
            { name: 'aTokenAddress', type: 'address' },
            { name: 'stableDebtTokenAddress', type: 'address' },
            { name: 'variableDebtTokenAddress', type: 'address' },
            { name: 'interestRateStrategyAddress', type: 'address' },
            { name: 'accruedToTreasury', type: 'uint128' },
            { name: 'unbacked', type: 'uint128' },
            { name: 'isolationModeTotalDebt', type: 'uint128' },
          ],
        },
      ],
    },
  ] as const

  const erc20Abi = [
    { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
    { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
    { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  ] as const

  const reserves = (await client.readContract({ address: pool, abi: poolAbi, functionName: 'getReservesList' })) as Address[]
  console.log(`Aave V3 Avalanche reserves count: ${reserves.length}`)

  const rows: {
    asset: Address
    symbol: string
    decimals: number
    aToken: Address
    liquidityIndex: bigint
    totalSupply: bigint
    supplyApy: number
    borrowApy: number
  }[] = []

  for (const asset of reserves) {
    try {
      const [data, symbol, decimals] = await Promise.all([
        client.readContract({ address: pool, abi: poolAbi, functionName: 'getReserveData', args: [asset] }) as Promise<{
          aTokenAddress: Address
          liquidityIndex: bigint
          currentLiquidityRate: bigint
          currentVariableBorrowRate: bigint
        }>,
        client.readContract({ address: asset, abi: erc20Abi, functionName: 'symbol' }) as Promise<string>,
        client.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals' }) as Promise<number>,
      ])
      const totalSupply = (await client.readContract({
        address: data.aTokenAddress,
        abi: erc20Abi,
        functionName: 'totalSupply',
      })) as bigint
      rows.push({
        asset,
        symbol,
        decimals,
        aToken: data.aTokenAddress,
        liquidityIndex: data.liquidityIndex,
        totalSupply,
        supplyApy: Number(data.currentLiquidityRate) / 1e27,
        borrowApy: Number(data.currentVariableBorrowRate) / 1e27,
      })
    } catch (err) {
      console.warn(`读取 ${asset} 失败:`, err instanceof Error ? err.message : String(err))
    }
  }

  // 按 aToken totalSupply * liquidityIndex 排序(底层 token 数量)
  const sorted = rows
    .map((r) => ({
      ...r,
      underlyingLiquidity: (r.totalSupply * r.liquidityIndex) / 10n ** 27n,
    }))
    .sort((a, b) => (b.underlyingLiquidity > a.underlyingLiquidity ? 1 : -1))

  console.log('\nTop reserves by underlying liquidity (token units):')
  console.log('Rank | Symbol | Asset | aToken | Liquidity | Supply APY | Borrow APY')
  sorted.slice(0, 20).forEach((r, i) => {
    console.log(
      `${(i + 1).toString().padStart(4)} | ${r.symbol.padEnd(6)} | ${r.asset} | ${r.aToken} | ` +
      `${formatUnits(r.underlyingLiquidity, r.decimals).padStart(18)} | ` +
      `${(r.supplyApy * 100).toFixed(2)}% | ${(r.borrowApy * 100).toFixed(2)}%`,
    )
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
