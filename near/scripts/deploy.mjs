// TinyWorld NEAR 合约部署 + 冒烟测试脚本（testnet，无需 CLI）。
// 用法: node deploy.mjs [account_id]   默认 tinyworld.testnet
//
// 流程：生成/复用 ed25519 密钥 → faucet 创建账户（如不存在）→ 部署 wasm + new() 初始化
//      → 冒烟：注册装备 / 铸身份 / 铸部件 / 穿戴 / 人格 / 查询。
// 密钥保存在 ~/.near-credentials/<account_id>.json（near CLI 标准位置）。
// --code-only：账户已存在且已初始化时只更新合约代码（跳过 faucet/new/冒烟）。
import { connect, keyStores, KeyPair, transactions } from "near-api-js";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const ACCOUNT_ID = positional[0] || "tinyworld.testnet";
const CODE_ONLY = process.argv.includes("--code-only");
const MIGRATE = process.argv.includes("--migrate"); // 结构变更升级:部署后调用 migrate() 迁移状态
const NETWORK_ID = "testnet";
const NODE_URL = "https://rpc.testnet.fastnear.com"; // rpc.testnet.near.org 已弃用(429)
const FAUCET_URL = "https://helper.testnet.near.org/account";
const WASM_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "target", "wasm32-unknown-unknown", "release", "tinyworld_near.wasm");

const credDir = join(homedir(), ".near-credentials");
const credPath = join(credDir, `${ACCOUNT_ID}.json`);
const keyStore = new keyStores.UnencryptedFileSystemKeyStore(credDir);

function loadOrCreateKey() {
  if (existsSync(credPath)) {
    const cred = JSON.parse(readFileSync(credPath, "utf8"));
    console.log(`reusing existing key for ${ACCOUNT_ID}`);
    return KeyPair.fromString(cred.private_key);
  }
  const keyPair = KeyPair.fromRandom("ed25519");
  mkdirSync(credDir, { recursive: true });
  writeFileSync(credPath, JSON.stringify({
    account_id: ACCOUNT_ID,
    private_key: keyPair.toString(),
    public_key: keyPair.getPublicKey().toString(),
  }, null, 2));
  console.log(`created new key for ${ACCOUNT_ID} -> ${credPath}`);
  return keyPair;
}

async function accountExists(near, id) {
  try {
    await near.connection.provider.query({ request_type: "view_account", finality: "final", account_id: id });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const keyPair = loadOrCreateKey();
  await keyStore.setKey(NETWORK_ID, ACCOUNT_ID, keyPair);

  const near = await connect({ networkId: NETWORK_ID, nodeUrl: NODE_URL, keyStore });
  const account = await near.account(ACCOUNT_ID);

  if (!(await accountExists(near, ACCOUNT_ID))) {
    console.log(`creating ${ACCOUNT_ID} via faucet...`);
    const res = await fetch(FAUCET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newAccountId: ACCOUNT_ID, newAccountPublicKey: keyPair.getPublicKey().toString() }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`faucet failed: ${res.status} ${text}`);
    console.log(`faucet: ${text}`);
  } else {
    const state = await account.state();
    console.log(`account exists, balance: ${(BigInt(state.amount) / 10n ** 24n).toString()} NEAR`);
  }

  const wasm = readFileSync(WASM_PATH);
  console.log(`deploying ${WASM_PATH} (${(wasm.length / 1024).toFixed(0)} KB)...`);
  if (CODE_ONLY) {
    await account.signAndSendTransaction({
      receiverId: ACCOUNT_ID,
      actions: [transactions.deployContract(wasm)],
    });
    console.log("code updated (code-only)");
    if (MIGRATE) {
      await account.functionCall({
        contractId: ACCOUNT_ID, methodName: "migrate", args: {},
        gas: 50n * 10n ** 12n, attachedDeposit: 0n,
      });
      console.log("state migrated (migrate)");
    }
    return;
  }
  await account.signAndSendTransaction({
    receiverId: ACCOUNT_ID,
    actions: [
      transactions.deployContract(wasm),
      transactions.functionCall("new", { owner_id: ACCOUNT_ID }, 30n * 10n ** 12n, 0n),
    ],
  });
  console.log("deployed + initialized (new)");

  // ---- 冒烟 ----
  const call = (method, args, deposit = 0n) =>
    account.functionCall({ contractId: ACCOUNT_ID, methodName: method, args, gas: 50n * 10n ** 12n, attachedDeposit: deposit });
  const view = (method, args) => account.viewFunction({ contractId: ACCOUNT_ID, methodName: method, args });

  console.log("smoke: register_part 1001/2001 ...");
  await call("register_part", { part_id: "1001", slot: 0, rarity: 1, max_supply: "100" });
  await call("register_part", { part_id: "2001", slot: 1, rarity: 1, max_supply: "100" });

  console.log("smoke: mint_identity (genesis) ...");
  await call("mint_identity", { name: "Genesis" });

  const identity = await view("get_identity_by_owner", { account_id: ACCOUNT_ID });
  console.log("identity:", JSON.stringify(identity));
  const tokenId = identity.token_id;

  console.log("smoke: mint_part + equip ...");
  await call("mint_part", { to: ACCOUNT_ID, part_id: "1001", amount: "1" });
  await call("equip", { token_id: tokenId, part_id: "1001", slot: 0 });

  console.log("smoke: update_persona ...");
  await call("update_persona", { token_id: tokenId, persona_hash: "ab".repeat(32), arweave_id: "" });

  const final = await view("get_identity", { token_id: tokenId });
  console.log("final identity:", JSON.stringify(final, null, 2));
  const fee = await view("get_current_fee", {});
  console.log(`mint_count: ${(await view("get_mint_count", {}))}, current fee: ${fee} yoctoNEAR`);
  console.log(`DONE. contract: ${ACCOUNT_ID}  explorer: https://testnet.nearblocks.io/address/${ACCOUNT_ID}`);
}

main().catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
