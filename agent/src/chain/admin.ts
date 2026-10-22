import type { Address } from 'viem'
import { getPublicClient } from './clients'
import { getChainContext } from './registry'

// ============================================================
// 链上管理员判定(与铸造后台同一套逻辑):
// 平台合约(DIDIdentity,UUPS Ownable)的 owner 即该链的管理员。
// 所有平台合约由同一部署者持有,此判定与 DIDParts owner 实质等价,
// 但语义锚定"平台根合约",不依赖任何链下白名单/.env。
// ============================================================

const ownableAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

export async function isChainAdmin(chainKey: string, address: string): Promise<boolean> {
  const identity = getChainContext(chainKey).cfg.identityAddress
  if (!identity || identity === '0x0000000000000000000000000000000000000000') return false
  const owner = (await getPublicClient(chainKey).readContract({
    address: identity as Address,
    abi: ownableAbi,
    functionName: 'owner',
  })) as Address
  return owner.toLowerCase() === address.toLowerCase()
}
