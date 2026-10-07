import { getWalletAssets, getEquipment, getAgentPermissions, listRecentAgents, resolveTokenId, ownerOf } from '../src/chain/persona'

// 本脚本固定跑 Solana testnet(多链重构后链调用首参 chainKey)
const CHAIN = 'solana-testnet'

const owner = 'Fd63rofpFDFKQbYanA2pb3TptWS1sfsKjJNCYFMyU1dH'
const tokenId = 9109078496724941000

async function main() {
  console.log('resolveTokenId:', await resolveTokenId(CHAIN, owner))
  console.log('ownerOf:', await ownerOf(CHAIN, tokenId))
  console.log('permissions(no PDA):', await getAgentPermissions(CHAIN, tokenId, '9R24oxGQZdUDXWNPbUjAQUr6fUELNvy7vn1ZP9Lkkcqp'))
  console.log('assets:', JSON.stringify(await getWalletAssets(CHAIN, owner, tokenId)))
  console.log('equipment:', JSON.stringify(await getEquipment(CHAIN, tokenId)))
  console.log('recent:', JSON.stringify(await listRecentAgents(CHAIN, 3)))
}
main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
