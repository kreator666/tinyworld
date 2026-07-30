import { createPublicClient, createWalletClient, custom, http, zeroAddress, type Address, type Hash } from 'viem'
import type { Equipped } from '../types'
import { getActiveProvider } from './wallet'
import {
  FALLBACK_RPC,
  IDENTITY_ADDRESS,
  PARTS_ADDRESS,
  SLOT_TO_CATEGORY,
  TARGET_CHAIN,
  TARGET_CHAIN_ID,
  chainParts,
  identityAbi,
  partByChainId,
  partsAbi,
} from './contracts'
import { ALL_CHAIN_IDS } from '../data/equipmentCatalog'

// ============================================================
// 链交互层:网络切换 + 读(资产识别)+ 写(铸造/穿戴)+ 管理员发行
// 读默认走已连接钱包的 provider,无钱包时回退公共 RPC
// ============================================================

const RARITY_LABELS = ['普通', '稀有', '史诗', '传说'] as const

export interface ChainPartAsset {
  id: number // 链上 id
  localId: string // 本地部件 id
  slot: number
  name: string
  rarity: string
  balance: number
}

export interface ChainPartState {
  id: number
  localId: string
  slot: number
  name: string
  rarity: string
  maxSupply: number
  mintable: boolean
  registered: boolean
  totalSupply: number
}

export interface ChainIdentityState {
  tokenId: number // 0 = 未铸造
  didName: string
  equipped: Equipped // 链上装备映射到本地部件 id
  parts: ChainPartAsset[]
}

export interface AdminMintConfig {
  to: Address
  ids: bigint[]
  amounts: bigint[]
}

function readClient() {
  const provider = getActiveProvider()
  return createPublicClient({
    chain: TARGET_CHAIN,
    transport: provider ? custom(provider) : http(FALLBACK_RPC),
    batch: { multicall: true },
  })
}

function walletClient(account: Address) {
  const provider = getActiveProvider()
  if (!provider) throw new Error('未检测到已连接的钱包,请先连接')
  return createWalletClient({ account, chain: TARGET_CHAIN, transport: custom(provider) })
}

/** 确保钱包切到 Sepolia(未添加过则先添加网络) */
export async function ensureSepolia(): Promise<void> {
  const provider = getActiveProvider()
  if (!provider) throw new Error('未检测到钱包扩展')
  const chainIdHex = (await provider.request({ method: 'eth_chainId' })) as string
  if (Number.parseInt(chainIdHex, 16) === TARGET_CHAIN_ID) return
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${TARGET_CHAIN_ID.toString(16)}` }],
    })
  } catch (err) {
    const code = (err as { code?: number })?.code
    if (code === 4902) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: `0x${TARGET_CHAIN_ID.toString(16)}`,
            chainName: 'Sepolia',
            nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'],
            blockExplorerUrls: ['https://sepolia.etherscan.io'],
          },
        ],
      })
      return
    }
    throw err
  }
}

/** 读取地址的链上身份与配件资产(使用 balanceOfBatch 优化,避免 120 次单读) */
export async function fetchChainState(address: Address): Promise<ChainIdentityState> {
  const client = readClient()

  const tokenId = (await client.readContract({
    address: IDENTITY_ADDRESS,
    abi: identityAbi,
    functionName: 'tokenIdOf',
    args: [address],
  })) as bigint

  let didName = ''
  const equipped: Equipped = { head: null, body: null, accessory: null, pet: null }
  if (tokenId > 0n) {
    const [name, items] = await Promise.all([
      client.readContract({ address: IDENTITY_ADDRESS, abi: identityAbi, functionName: 'nameOf', args: [tokenId] }) as Promise<string>,
      client.readContract({ address: IDENTITY_ADDRESS, abi: identityAbi, functionName: 'getEquipped', args: [tokenId] }) as Promise<
        [Address, bigint][]
      >,
    ])
    didName = name
    items.forEach((item, slot) => {
      // viem 对 tuple[4] 的返回可能是对象数组或数组数组,做兼容处理
      const raw = item as unknown as { collection: Address; id: bigint } | [Address, bigint]
      const collection = Array.isArray(raw) ? raw[0] : raw.collection
      const id = Array.isArray(raw) ? raw[1] : raw.id
      if (collection === zeroAddress) return
      const part = partByChainId(id)
      const category = SLOT_TO_CATEGORY[slot]
      if (part && category) equipped[category] = part.localId
    })
  }

  const allIds = ALL_CHAIN_IDS.map((id) => BigInt(id))
  const accounts = allIds.map(() => address)
  const balances = (await client.readContract({
    address: PARTS_ADDRESS,
    abi: partsAbi,
    functionName: 'balanceOfBatch',
    args: [accounts, allIds],
  })) as bigint[]

  const parts = chainParts.map((p, idx) => ({
    id: p.id,
    localId: p.localId,
    slot: p.slot,
    name: p.name,
    rarity: p.rarity,
    balance: Number(balances[idx] ?? 0n),
  }))

  return { tokenId: Number(tokenId), didName, equipped, parts }
}

/** 铸造 DID 主身份,返回 tx hash(等待上链确认后 resolve) */
export async function mintIdentity(owner: Address, name: string, profileURI: string): Promise<Hash> {
  const wallet = walletClient(owner)
  const hash = await wallet.writeContract({
    address: IDENTITY_ADDRESS,
    abi: identityAbi,
    functionName: 'mint',
    args: [name, profileURI],
    gas: 300000n,
  })
  await readClient().waitForTransactionReceipt({ hash })
  return hash
}

/** 穿戴:首次自动授权身份合约托管配件,然后装备 */
export async function equipPart(owner: Address, tokenId: number, slot: number, partChainId: number): Promise<Hash> {
  const client = readClient()
  const wallet = walletClient(owner)

  const approved = (await client.readContract({
    address: PARTS_ADDRESS,
    abi: partsAbi,
    functionName: 'isApprovedForAll',
    args: [owner, IDENTITY_ADDRESS],
  })) as boolean
  if (!approved) {
    const approveHash = await wallet.writeContract({
      address: PARTS_ADDRESS,
      abi: partsAbi,
      functionName: 'setApprovalForAll',
      args: [IDENTITY_ADDRESS, true],
      gas: 100000n,
    })
    await client.waitForTransactionReceipt({ hash: approveHash })
  }

  const hash = await wallet.writeContract({
    address: IDENTITY_ADDRESS,
    abi: identityAbi,
    functionName: 'equip',
    args: [BigInt(tokenId), slot, PARTS_ADDRESS, BigInt(partChainId)],
    gas: 400000n,
  })
  await client.waitForTransactionReceipt({ hash })
  return hash
}

/** 卸下配件(退回持有者钱包) */
export async function unequipPart(owner: Address, tokenId: number, slot: number): Promise<Hash> {
  const wallet = walletClient(owner)
  const hash = await wallet.writeContract({
    address: IDENTITY_ADDRESS,
    abi: identityAbi,
    functionName: 'unequip',
    args: [BigInt(tokenId), slot],
    gas: 300000n,
  })
  await readClient().waitForTransactionReceipt({ hash })
  return hash
}

// ============================================================
// 管理员发行
// ============================================================

/** 判断地址是否为 DIDParts owner */
export async function isPartsOwner(account: Address): Promise<boolean> {
  const owner = (await readClient().readContract({
    address: PARTS_ADDRESS,
    abi: partsAbi,
    functionName: 'owner',
  })) as Address
  return owner.toLowerCase() === account.toLowerCase()
}

/** 判断地址是否被授权为 DIDParts minter */
export async function isPartsMinter(account: Address): Promise<boolean> {
  return (await readClient().readContract({
    address: PARTS_ADDRESS,
    abi: partsAbi,
    functionName: 'minters',
    args: [account],
  })) as boolean
}

/** 读取全部 120 件装备的链上注册状态与总供应量(利用 multicall 批处理) */
export async function fetchPartStates(): Promise<ChainPartState[]> {
  const client = readClient()
  const allIds = ALL_CHAIN_IDS.map((id) => BigInt(id))
  const states = await Promise.all(
    allIds.map((id, idx) => {
      const p = chainParts[idx]
      const infoPromise = client.readContract({
        address: PARTS_ADDRESS,
        abi: partsAbi,
        functionName: 'parts',
        args: [id],
      }) as Promise<[number, number, bigint, boolean, boolean]>
      const totalPromise = client.readContract({
        address: PARTS_ADDRESS,
        abi: partsAbi,
        functionName: 'totalSupply',
        args: [id],
      }) as Promise<bigint>
      return Promise.all([infoPromise, totalPromise]).then(([info, total]) => ({
        id: p.id,
        localId: p.localId,
        slot: p.slot,
        name: p.name,
        rarity: p.rarity,
        maxSupply: Number(info[2]),
        mintable: info[3],
        registered: info[4],
        totalSupply: Number(total),
      }))
    }),
  )
  return states
}

/** 单条注册配件(需 owner 权限) */
export async function registerPart(
  owner: Address,
  chainId: number,
  slot: number,
  rarity: number,
  maxSupply: number,
): Promise<Hash> {
  const wallet = walletClient(owner)
  const hash = await wallet.writeContract({
    address: PARTS_ADDRESS,
    abi: partsAbi,
    functionName: 'registerPart',
    args: [BigInt(chainId), slot, rarity, BigInt(maxSupply)],
    gas: 250000n,
  })
  await readClient().waitForTransactionReceipt({ hash })
  return hash
}

export interface RegisterProgress {
  current: number
  total: number
  txHash: Hash | null
  chainId: number | null
}

/** 批量注册配件(顺序执行,每笔等待确认;通过 onProgress 回调报告进度) */
export async function registerPartsBatch(
  owner: Address,
  parts: { chainId: number; slot: number; rarity: number; maxSupply: number; name: string }[],
  onProgress?: (p: RegisterProgress) => void,
): Promise<Hash[]> {
  const hashes: Hash[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    onProgress?.({ current: i + 1, total: parts.length, txHash: null, chainId: part.chainId })
    const hash = await registerPart(owner, part.chainId, part.slot, part.rarity, part.maxSupply)
    hashes.push(hash)
    onProgress?.({ current: i + 1, total: parts.length, txHash: hash, chainId: part.chainId })
  }
  return hashes
}

/** 批量铸造配件(需 minter 权限) */
export async function mintPartsBatch(owner: Address, to: Address, ids: bigint[], amounts: bigint[]): Promise<Hash> {
  if (ids.length === 0 || amounts.length === 0 || ids.length !== amounts.length) {
    throw new Error('铸造参数不能为空且 ids 与 amounts 长度必须一致')
  }
  const wallet = walletClient(owner)
  const hash = await wallet.writeContract({
    address: PARTS_ADDRESS,
    abi: partsAbi,
    functionName: 'mintPartBatch',
    args: [to, ids, amounts],
    gas: BigInt(300000 + ids.length * 80000),
  })
  await readClient().waitForTransactionReceipt({ hash })
  return hash
}

/** 把链上错误翻译成中文提示 */
export function explainChainError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/AlreadyHasDID/.test(msg)) return '该地址已铸造过 DID 身份(每地址限 1 枚)'
  if (/NameTaken/.test(msg)) return '该名称已被占用,请换一个'
  if (/InvalidName/.test(msg)) return '名称不符合要求(1-64 字符)'
  if (/NotMinter/.test(msg)) return '当前地址没有 DIDParts 铸造权限(需 owner 或授权 minter)'
  if (/OwnableUnauthorizedAccount/.test(msg)) return '当前地址不是 DIDParts 合约 owner'
  if (/PartAlreadyRegistered/.test(msg)) return '该配件已注册,不能重复注册'
  if (/PartNotRegistered/.test(msg)) return '该配件尚未注册,请先注册'
  if (/PartNotMintable/.test(msg)) return '该配件已关闭铸造(mintable=false)'
  if (/MaxSupplyExceeded/.test(msg)) return '铸造数量超过该配件最大供应量'
  if (/InvalidMaxSupply/.test(msg)) return '最大供应量必须大于 0'
  if (/User rejected|rejected|denied|Denied/i.test(msg)) return '你取消了钱包操作'
  if (/NotTokenOwner/.test(msg)) return '只有 DID 持有者本人可以操作'
  if (/NothingEquipped/.test(msg)) return '该插槽没有装备中的配件'
  if (/insufficient funds/i.test(msg)) return '钱包 Sepolia ETH 余额不足,请先领取测试币'
  return `链上操作失败: ${msg.length > 120 ? msg.slice(0, 120) + '…' : msg}`
}

export { TARGET_CHAIN_ID } from './contracts'
