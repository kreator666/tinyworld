import { getChainContext } from '../src/chain/registry'
import { getPublicClient } from '../src/chain/clients'
import { formatUnits, type Address } from 'viem'

// 读取 Avalanche 主网 Aave v3 所有储备资产,按 USD 流动性排序
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
    {
      type: 'function',
      name: 'ADDRESSES_PROVIDER',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'address' }],
    },
  ] as const

  const addressesProviderAbi = [
    {
      type: 'function',
      name: 'getPriceOracle',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'address' }],
    },
  ] as const

  const oracleAbi = [
    {
      type: 'function',
      name: 'getAssetPrice',
      stateMutability: 'view',
      inputs: [{ name: 'asset', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }],
    },
    {
      type: 'function',
      name: 'BASE_CURRENCY',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'address' }],
    },
    {
      type: 'function',
      name: 'BASE_CURRENCY_UNIT',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'uint256' }],
    },
  ] as const

  const erc20Abi = [
    { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
    { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
    { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  ] as const

  const reserves = (await client.readContract({ address: pool, abi: poolAbi, functionName: 'getReservesList' })) as Address[]
  const addressesProvider = (await client.readContract({ address: pool, abi: poolAbi, functionName: 'ADDRESSES_PROVIDER' })) as Address
  const oracle = (await client.readContract({ address: addressesProvider, abi: addressesProviderAbi, functionName: 'getPriceOracle' })) as Address
  const baseCurrencyUnit = (await client.readContract({ address: oracle, abi: oracleAbi, functionName: 'BASE_CURRENCY_UNIT' })) as bigint
  console.log(`reserves: ${reserves.length}, oracle: ${oracle}, baseCurrencyUnit: ${baseCurrencyUnit.toString()}`)

  const rows: {
    asset: Address
    symbol: string
    decimals: number
    aToken: Address
    liquidityIndex: bigint
    totalSupply: bigint
    price: bigint
    supplyApy: number
    borrowApy: number
  }[] = []

  for (const asset of reserves) {
    try {
      const [data, symbol, decimals, price] = await Promise.all([
        client.readContract({ address: pool, abi: poolAbi, functionName: 'getReserveData', args: [asset] }) as Promise<{
          aTokenAddress: Address
          liquidityIndex: bigint
          currentLiquidityRate: bigint
          currentVariableBorrowRate: bigint
        }>,
        client.readContract({ address: asset, abi: erc20Abi, functionName: 'symbol' }) as Promise<string>,
        client.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals' }) as Promise<number>,
        client.readContract({ address: oracle, abi: oracleAbi, functionName: 'getAssetPrice', args: [asset] }) as Promise<bigint>,
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
        price,
        supplyApy: Number(data.currentLiquidityRate) / 1e27,
        borrowApy: Number(data.currentVariableBorrowRate) / 1e27,
      })
    } catch (err) {
      console.warn(`读取 ${asset} 失败:`, err instanceof Error ? err.message : String(err))
    }
  }

  // USD 流动性 = underlyingLiquidity * price / baseCurrencyUnit
  const sorted = rows
    .map((r) => {
      const underlyingLiquidity = (r.totalSupply * r.liquidityIndex) / 10n ** 27n
      const priceNormalized = r.price // 价格精度 = baseCurrencyUnit,通常是 1e8
      const liquidityUsd = (underlyingLiquidity * priceNormalized) / baseCurrencyUnit / 10n ** BigInt(r.decimals)
      // 更精确:liquidityUsd = (underlyingLiquidity * priceNormalized) / (baseCurrencyUnit * 10^decimals)
      // 但这样可能溢出;用 BigInt 分开算
      return { ...r, underlyingLiquidity, liquidityUsd }
    })
    .sort((a, b) => (b.liquidityUsd > a.liquidityUsd ? 1 : -1))

  console.log('\nTop reserves by USD liquidity:')
  console.log('Rank | Symbol | Asset | Liquidity(USD) | Supply APY | Borrow APY')
  sorted.forEach((r, i) => {
    console.log(
      `${(i + 1).toString().padStart(4)} | ${r.symbol.padEnd(6)} | ${r.asset} | ` +
      `${formatUnits(r.liquidityUsd, 0).padStart(15)} | ` +
      `${(r.supplyApy * 100).toFixed(2)}% | ${(r.borrowApy * 100).toFixed(2)}%`,
    )
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
