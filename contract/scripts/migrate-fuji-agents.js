// Fuji 旧合约 → 新合约(ERC-8004)Agent 迁移脚本
// 用法: node scripts/migrate-fuji-agents.js
// 环境: contract/.env 的 PRIVATE_KEY(部署者,持有旧 tokenId 1);Fuji RPC 走公共端点
// 规则:
//   - 按旧 tokenId 顺序在新合约 mint,保持 tokenId 一一对应(可重复跑,已迁移的自动跳过)
//   - 旧 tokenId 1 的 owner = 部署者(私钥可得) → 原样铸给部署者
//   - 旧 tokenId 2..N 的 owner 私钥不可得 → 每个 Agent 生成一次性迁移钱包(gitignored 存档),
//     owner 变更清单打印在结果表里
//   - persona(uri+hash)原样回写;装备由 minter 重新发给新 owner 后 setApprovalForAll + equip 还原
//   - 每个新 Agent 给 agent 服务热钱包授权 PERMISSION_PERSONA,保证 scheduler 可装载/更新人格
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = process.env.FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc";
const OLD_IDENTITY = "0x15dC02b5678b8454C75EeA0208C1C027b1903d9c";
const OLD_PARTS = "0xdac819D6B834E26B23EE30Edc9C13eA0a4b834f2";
const NEW_IDENTITY = "0x386b7Ec042659855386B25D70114C285F328eE65";
const NEW_PARTS = "0x884dA9E2E1681Ada159e5DA0ddBb19bc858E0267";
// agent 服务热钱包(公钥地址,仅授权用;私钥不出 agent 服务)
const HOT_WALLET = "0xD79d3450B0f754837e5a1BbeaD88B34d139B0363";
const PERMISSION_PERSONA = 1n;

const abiOf = (name) => require(path.join(__dirname, "../out", `${name}.sol`, `${name}.json`)).abi;
const IDENTITY_ABI = abiOf("DIDIdentity");
const PARTS_ABI = abiOf("DIDParts");

const WALLETS_FILE = path.join(__dirname, ".migration-wallets.json");

function loadWalletStore() {
  try {
    return JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  console.log(`部署者(旧 tokenId 1 owner): ${deployer.address}`);
  console.log(`余额: ${ethers.formatEther(await provider.getBalance(deployer.address))} AVAX\n`);

  const oldIdentity = new ethers.Contract(OLD_IDENTITY, IDENTITY_ABI, provider);
  const oldParts = new ethers.Contract(OLD_PARTS, PARTS_ABI, provider);
  const newIdentityD = new ethers.Contract(NEW_IDENTITY, IDENTITY_ABI, deployer); // deployer 视角
  const newPartsD = new ethers.Contract(NEW_PARTS, PARTS_ABI, deployer);
  const newIdentityR = new ethers.Contract(NEW_IDENTITY, IDENTITY_ABI, provider);

  const total = Number(await oldIdentity.totalMinted());
  const already = Number(await newIdentityR.totalMinted());
  console.log(`旧合约 Agent 数: ${total},新合约已迁移: ${already}\n`);

  const store = loadWalletStore();
  const results = [];

  for (let tid = 1; tid <= total; ++tid) {
    const name = await oldIdentity.nameOf(tid);
    const profileURI = await oldIdentity.profileURIOf(tid);
    const persona = await oldIdentity.personaOf(tid);
    const equipped = await oldIdentity.getEquipped(tid);
    const oldOwner = await oldIdentity.ownerOf(tid);

    // 目标 owner:tokenId 1 用部署者,其余用一次性迁移钱包
    let targetSigner;
    let ownerChanged = false;
    if (tid === 1) {
      targetSigner = deployer;
    } else {
      ownerChanged = true;
      if (!store[tid]) {
        const w = ethers.Wallet.createRandom().connect(provider);
        store[tid] = w.privateKey; // 仅存本地 gitignored 文件,不打印
        fs.writeFileSync(WALLETS_FILE, JSON.stringify(store, null, 2));
        // 资助 gas
        const tx = await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("0.02") });
        await tx.wait();
      }
      targetSigner = new ethers.Wallet(store[tid], provider);
    }

    // ① mint(幂等:目标地址已持有正确 tokenId 则跳过)
    const owned = Number(await newIdentityR.tokenIdOf(targetSigner.address));
    if (owned === tid) {
      console.log(`#${tid} ${name}: 已迁移,跳过`);
    } else {
      if (Number(await newIdentityR.totalMinted()) !== tid - 1) {
        throw new Error(`#${tid} 无法保持顺序迁移:新合约 totalMinted != ${tid - 1},请检查`);
      }
      const tx = await newIdentityD.connect(targetSigner).mint(name, profileURI);
      await tx.wait();
      console.log(`#${tid} ${name}: mint → 新 tokenId ${tid}`);
    }

    // ② persona 回写(仅旧链上有内容时;调用者 = 新 owner)
    if (persona.contentHash !== ethers.ZeroHash && (await newIdentityR.personaOf(tid)).contentHash === ethers.ZeroHash) {
      const tx = await newIdentityD.connect(targetSigner).setPersona(tid, persona.uri, persona.contentHash);
      await tx.wait();
      console.log(`#${tid} ${name}: persona 已回写`);
    }

    // ③ 给 agent 服务热钱包授权 PERMISSION_PERSONA(scheduler 装载/更新人格用)
    if ((await newIdentityR.agentPermissions(tid, HOT_WALLET)) === 0n) {
      const tx = await newIdentityD.connect(targetSigner).setAgent(tid, HOT_WALLET, PERMISSION_PERSONA);
      await tx.wait();
      console.log(`#${tid} ${name}: 热钱包已授权 PERMISSION_PERSONA`);
    }

    // ④ 装备还原:新 parts 发给新 owner → 授权 → equip(仅旧链装备在新 parts 已注册时)
    for (let slot = 0; slot < 4; ++slot) {
      const [collection, id] = equipped[slot];
      if (collection === ethers.ZeroAddress) continue;
      const cur = await newIdentityR.getEquipped(tid);
      if (cur[slot][0] !== ethers.ZeroAddress) continue; // 已装备
      // 从旧 parts 读该 id 的插槽,确认在新 parts 同 id 同槽(新合约 1:1 注册了 120 件)
      const newSlot = await newPartsD.slotOf(id); // 未注册会 revert
      if (Number(newSlot) !== slot) throw new Error(`#${tid} slot ${slot}: 新 parts ${id} 槽位不符`);
      const tx1 = await newPartsD.mintPart(targetSigner.address, id, 1); // deployer 是 minter
      await tx1.wait();
      const tx2 = await newPartsD.connect(targetSigner).setApprovalForAll(NEW_IDENTITY, true);
      await tx2.wait();
      const tx3 = await newIdentityD.connect(targetSigner).equip(tid, slot, NEW_PARTS, id);
      await tx3.wait();
      console.log(`#${tid} ${name}: 装备 slot${slot} ← ${id}`);
    }

    results.push({ tokenId: tid, name, oldOwner, newOwner: targetSigner.address, ownerChanged });
  }

  console.log("\n===== 迁移结果 =====");
  console.log("tokenId | 名称 | 旧 owner | 新 owner | owner 变更");
  for (const r of results) {
    console.log(`#${r.tokenId} | ${r.name} | ${r.oldOwner} | ${r.newOwner} | ${r.ownerChanged ? "是" : "否"}`);
  }
  const changed = results.filter((r) => r.ownerChanged);
  if (changed.length) {
    console.log(`\nowner 已变更(${changed.length} 个,一次性迁移钱包私钥见 scripts/.migration-wallets.json,未入库):`);
    for (const r of changed) console.log(`  #${r.tokenId} ${r.name}: ${r.oldOwner} → ${r.newOwner}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
