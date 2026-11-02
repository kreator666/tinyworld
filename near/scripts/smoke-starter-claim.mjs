// 新手大礼包链上冒烟:用创世身份领取并读回装备状态
import { connect, keyStores, KeyPair } from "near-api-js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONTRACT = "tinyworld.testnet";
const RPC = "https://rpc.testnet.fastnear.com";
const cred = JSON.parse(readFileSync(join(homedir(), ".near-credentials", `${CONTRACT}.json`), "utf8"));
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey("testnet", CONTRACT, KeyPair.fromString(cred.private_key));
const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore });
const account = await near.account(CONTRACT);

console.log("claimed before:", await account.viewFunction({ contractId: CONTRACT, methodName: "is_starter_claimed", args: { account_id: CONTRACT } }));
await account.functionCall({ contractId: CONTRACT, methodName: "claim_starter_pack", args: {}, gas: 100n * 10n ** 12n, attachedDeposit: 0n });
console.log("claimed after:", await account.viewFunction({ contractId: CONTRACT, methodName: "is_starter_claimed", args: { account_id: CONTRACT } }));
const id = await account.viewFunction({ contractId: CONTRACT, methodName: "get_identity_by_owner", args: { account_id: CONTRACT } });
console.log("equipped:", JSON.stringify(id.equipped));
// 重复领取应失败
try {
  await account.functionCall({ contractId: CONTRACT, methodName: "claim_starter_pack", args: {}, gas: 50n * 10n ** 12n, attachedDeposit: 0n });
  console.log("RE-CHECK: second claim succeeded?! BUG");
} catch (e) {
  console.log("second claim rejected as expected:", String(e.message || e).slice(0, 120));
}
