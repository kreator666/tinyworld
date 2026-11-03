// 注册 32 件新手装备(每槽 1001-1008 / 2001-2008 / 3001-3008 / 4001-4008,对照 EVM SeedParts 前 8 件)
// 已注册/满额的自动跳过。用法: node seed-starter-parts.mjs [contract]
import { connect, keyStores, KeyPair } from "near-api-js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONTRACT = process.argv[2] || "tinyworld.testnet";
const MAINNET = process.env.NEAR_NETWORK === "mainnet";
const RPC = MAINNET ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com";
const cred = JSON.parse(readFileSync(join(homedir(), ".near-credentials", `${CONTRACT}.json`), "utf8"));
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey(MAINNET ? "mainnet" : "testnet", CONTRACT, KeyPair.fromString(cred.private_key));
const near = await connect({ networkId: MAINNET ? "mainnet" : "testnet", nodeUrl: RPC, keyStore });
const account = await near.account(CONTRACT);

// rarity 规律:前 2 普通(0),次 4 稀有(1),后 2 史诗(2);max_supply 给足(对照 EVM 创世件量级)
const RARITY = [0, 0, 1, 1, 1, 1, 2, 2];
let registered = 0, skipped = 0;
for (let slot = 0; slot < 4; slot++) {
  for (let i = 1; i <= 8; i++) {
    const partId = (slot + 1) * 1000 + i;
    const existing = await account.viewFunction({ contractId: CONTRACT, methodName: "get_part", args: { part_id: String(partId) } });
    if (existing?.registered) { skipped++; continue; }
    await account.functionCall({
      contractId: CONTRACT, methodName: "register_part",
      args: { part_id: String(partId), slot, rarity: RARITY[i - 1], max_supply: "10000" },
      gas: 30n * 10n ** 12n, attachedDeposit: 0n,
    });
    registered++;
  }
}
console.log(`registered: ${registered}, skipped(existing): ${skipped}`);
