// 一次性转账:tinyworld.testnet → 指定账户(testnet)
// 用法: node transfer.mjs <to_account_id> <amount_in_near>
import { connect, keyStores, KeyPair, transactions, utils } from "near-api-js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FROM = "tinyworld.testnet";
const [to, amountNear] = process.argv.slice(2);
if (!to || !amountNear) { console.error("usage: node transfer.mjs <to> <amountNEAR>"); process.exit(1); }

const RPC = "https://rpc.testnet.fastnear.com"; // rpc.testnet.near.org 已弃用(429)
const cred = JSON.parse(readFileSync(join(homedir(), ".near-credentials", `${FROM}.json`), "utf8"));
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey("testnet", FROM, KeyPair.fromString(cred.private_key));
const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore });
const account = await near.account(FROM);

const yocto = BigInt(utils.format.parseNearAmount(amountNear));
const out = await account.signAndSendTransaction({
  receiverId: to,
  actions: [transactions.transfer(yocto)],
});
const hash = out.transaction_outcome?.id ?? out.transaction?.hash;
console.log(`transferred ${amountNear} NEAR ${FROM} -> ${to}, tx: ${hash}`);
const toState = await (await near.account(to)).state();
console.log(`${to} balance: ${(BigInt(toState.amount) / 10n ** 24n).toString()}.${String(BigInt(toState.amount) % 10n ** 24n).slice(0, 4)} NEAR`);
