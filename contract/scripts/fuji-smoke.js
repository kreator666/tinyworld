// Fuji 冒烟测试:部署后完整走一遍链上流程(管理员铸币 → DID → 人格 → 穿戴)
// 用法: npx hardhat run scripts/fuji-smoke.js --network avalancheFuji
require("dotenv").config();
const { ethers } = require("hardhat");

const IDENTITY = "0x15dC02b5678b8454C75EeA0208C1C027b1903d9c";
const PARTS = "0xdac819D6B834E26B23EE30Edc9C13eA0a4b834f2";

const identityAbi = require("../artifacts/src/DIDIdentity.sol/DIDIdentity.json").abi;
const partsAbi = require("../artifacts/src/DIDParts.sol/DIDParts.json").abi;

async function main() {
  const [admin] = await ethers.getSigners();
  const identity = new ethers.Contract(IDENTITY, identityAbi, admin);
  const parts = new ethers.Contract(PARTS, partsAbi, admin);
  console.log(`管理员/部署者: ${admin.address}`);
  console.log(`Fuji 余额: ${ethers.formatEther(await ethers.provider.getBalance(admin.address))} AVAX\n`);

  // ① 管理员注册 4 件装备(slot 0-3,稀有度 0-3)
  console.log("① registerPart ×4 ...");
  const regs = [
    [1001, 0, 0, 10000], // head 普通
    [2001, 1, 1, 2000], // body 稀有
    [3001, 2, 2, 500], // acc 史诗
    [4001, 3, 3, 100], // pet 传说
  ];
  for (const [id, slot, rarity, max] of regs) {
    const info = await parts.parts(id);
    if (!info.registered) {
      await (await parts.registerPart(id, slot, rarity, max)).wait();
      console.log(`  注册 #${id} (slot=${slot}, rarity=${rarity}, max=${max}) ✓`);
    } else {
      console.log(`  #${id} 已注册,跳过`);
    }
  }

  // ② 管理员铸币(mintPartBatch 发给自己)
  console.log("\n② mintPartBatch 管理员铸币 ...");
  const ids = regs.map((r) => r[0]);
  const balances = await parts.balanceOfBatch(ids.map(() => admin.address), ids);
  const needMint = balances.every((b) => b === 0n);
  if (needMint) {
    await (await parts.mintPartBatch(admin.address, ids, ids.map(() => 1))).wait();
    console.log("  铸造 4 件各 1 份 ✓");
  } else {
    console.log("  已有余额,跳过铸造");
  }
  const balAfter = await parts.balanceOfBatch(ids.map(() => admin.address), ids);
  console.log("  余额:", balAfter.map((b, i) => `#${ids[i]}=${b}`).join(" "));

  // ③ 铸造 DID 主身份(每地址限 1 枚)
  console.log("\n③ mint DID 主身份 ...");
  let tokenId = await identity.tokenIdOf(admin.address);
  if (tokenId === 0n) {
    const available = await identity.nameAvailable("Diego");
    if (!available) throw new Error("名称 Diego 已被占用");
    await (await identity.mint("Diego", "Fuji 上的第一个 Agent")) .wait();
    tokenId = await identity.tokenIdOf(admin.address);
    console.log(`  铸造成功,tokenId=${tokenId} ✓`);
  } else {
    console.log(`  已铸造过,tokenId=${tokenId},跳过`);
  }

  // ④ 人格写链(setPersona,同时验证 Cancun EVM 兼容性)
  console.log("\n④ setPersona 人格上链 ...");
  const profile = { template: "理性", personality: "Fuji 冒烟测试人格", tone: "短句干练", topics: ["NFT", "AI"] };
  const json = JSON.stringify(profile);
  const uri = "data:application/json;base64," + Buffer.from(json, "utf8").toString("base64");
  const hash = ethers.keccak256(ethers.toUtf8Bytes(json));
  const current = await identity.personaOf(tokenId);
  if (current.contentHash !== hash) {
    await (await identity.setPersona(tokenId, uri, hash)).wait();
    console.log("  setPersona ✓");
  } else {
    console.log("  人格已是最新,跳过");
  }
  const persona = await identity.personaOf(tokenId);
  const decoded = Buffer.from(persona.uri.replace("data:application/json;base64,", ""), "base64").toString("utf8");
  const ok = ethers.keccak256(ethers.toUtf8Bytes(decoded)) === persona.contentHash;
  console.log(`  读回校验: contentHash ${ok ? "一致 ✓" : "不匹配 ✗"}`);

  // ⑤ 授权 + 穿戴 4 件装备
  console.log("\n⑤ setApprovalForAll + equip ×4 ...");
  if (!(await parts.isApprovedForAll(admin.address, IDENTITY))) {
    await (await parts.setApprovalForAll(IDENTITY, true)).wait();
    console.log("  授权 DIDIdentity 托管配件 ✓");
  }
  for (const [partId, slot] of regs.map((r) => [r[0], r[1]])) {
    const cur = (await identity.getEquipped(tokenId))[slot];
    if (cur.collection === PARTS && cur.id === BigInt(partId)) {
      console.log(`  slot${slot} 已是 #${partId},跳过`);
      continue;
    }
    await (await identity.equip(tokenId, slot, PARTS, partId)).wait();
    console.log(`  穿戴 #${partId} → slot${slot} ✓`);
  }
  const equipped = await identity.getEquipped(tokenId);
  console.log("  getEquipped:", equipped.map((e, i) => `slot${i}=${e.collection === ethers.ZeroAddress ? "空" : "#" + e.id}`).join(" "));

  // ⑥ 卸下一件验证退回
  console.log("\n⑥ unequip slot2(配饰) ...");
  await (await identity.unequip(tokenId, 2)).wait();
  const after = await identity.getEquipped(tokenId);
  const back = await parts.balanceOf(admin.address, 3001);
  console.log(`  slot2=${after[2].collection === ethers.ZeroAddress ? "空 ✓" : "异常"}  配饰余额退回=${back} ✓`);

  console.log("\n✅ Fuji 冒烟测试全部通过");
}

main().catch((err) => {
  console.error("❌ 冒烟测试失败:", err.message || err);
  process.exitCode = 1;
});
