import { getWalletAssets, getEquipment, getAgentPermissions, listRecentAgents, resolveTokenId, ownerOf } from '../src/chain/persona'

const owner = 'Fd63rofpFDFKQbYanA2pb3TptWS1sfsKjJNCYFMyU1dH'
const tokenId = 9109078496724941000

async function main() {
  console.log('resolveTokenId:', await resolveTokenId(owner))
  console.log('ownerOf:', await ownerOf(tokenId))
  console.log('permissions(no PDA):', await getAgentPermissions(tokenId, '9R24oxGQZdUDXWNPbUjAQUr6fUELNvy7vn1ZP9Lkkcqp'))
  console.log('assets:', JSON.stringify(await getWalletAssets(owner, tokenId)))
  console.log('equipment:', JSON.stringify(await getEquipment(tokenId)))
  console.log('recent:', JSON.stringify(await listRecentAgents(3)))
}
main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
