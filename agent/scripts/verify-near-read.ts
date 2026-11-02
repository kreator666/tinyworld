import { listMintedAgents, resolveTokenId, getEquipment, getWalletAssets, isValidNearAddress } from '../src/chain/personaNear.js';

const chain = 'near-testnet';
const agents = await listMintedAgents(chain);
console.log('listMintedAgents:', JSON.stringify(agents));
const tid = await resolveTokenId(chain, 'tinyworld.testnet');
console.log('resolveTokenId:', tid);
console.log('equipment:', JSON.stringify(await getEquipment(chain, tid)));
console.log('walletAssets:', JSON.stringify(await getWalletAssets(chain, 'tinyworld.testnet', tid)));
console.log('isValid alice.testnet:', isValidNearAddress('alice.testnet'), '| 0xabc:', isValidNearAddress('0xabc'));
