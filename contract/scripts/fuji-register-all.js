// Fuji 全量注册 120 件装备(与 Sepolia 同一套目录),并给管理员发一套演示装备
// 目录规则与 web/src/data/equipmentCatalog.ts 一致:
//   chainId = (slot+1)*1000 + index;slot 0头/1身/2配饰/3宠物;每类 30 件
//   普通 12(maxSupply 10000) 稀有 9(2000) 史诗 6(500) 传说 3(100)
// 幂等:已注册的跳过。用法: npx hardhat run scripts/fuji-register-all.js --network avalancheFuji
require("dotenv").config();
const { ethers } = require("hardhat");

const PARTS = "0xdac819D6B834E26B23EE30Edc9C13eA0a4b834f2";
const partsAbi = require("../artifacts/src/DIDParts.sol/DIDParts.json").abi;

const RARITY = [
  { rarity: 0, count: 12, maxSupply: 10000 }, // 普通
  { rarity: 1, count: 9, maxSupply: 2000 }, // 稀有
  { rarity: 2, count: 6, maxSupply: 500 }, // 史诗
  { rarity: 3, count: 3, maxSupply: 100 }, // 传说
];

async function main() {
  const [admin] = await ethers.getSigners();
  const parts = new ethers.Contract(PARTS, partsAbi, admin);
  console.log(`管理员: ${admin.address}`);
  console.log(`Fuji 余额: ${ethers.formatEther(await ethers.provider.getBalance(admin.address))} AVAX\n`);

  // ① 全量注册 120 件
  let registered = 0, skipped = 0;
  for (let slot = 0; slot < 4; slot++) {
    let index = 1;
    for (const r of RARITY) {
      for (let i = 0; i < r.count; i++, index++) {
        const id = (slot + 1) * 1000 + index;
        const info = await parts.parts(id);
        if (info.registered) { skipped++; continue; }
        await (await parts.registerPart(id, slot, r.rarity, r.maxSupply)).wait();
        registered++;
        if (registered % 10 === 0) console.log(`  已注册 ${registered} 件...`);
      }
    }
  }
  console.log(`① 注册完成: 新注册 ${registered}, 跳过 ${skipped}, 合计 ${registered + skipped}/120\n`);

  // ② 演示装备:每类前 3 件各发 1 份给管理员(素材展示用)
  const demoIds = [];
  for (let slot = 0; slot < 4; slot++) {
    for (let index = 1; index <= 3; index++) demoIds.push((slot + 1) * 1000 + index);
  }
  const accounts = demoIds.map(() => admin.address);
  const bals = await parts.balanceOfBatch(accounts, demoIds);
  const toMint = demoIds.filter((_, i) => bals[i] === 0n);
  if (toMint.length > 0) {
    await (await parts.mintPartBatch(admin.address, toMint, toMint.map(() => 1))).wait();
    console.log(`② 演示装备铸造 ${toMint.length} 件 ✓`);
  } else {
    console.log("② 演示装备已在账,跳过");
  }
  console.log("\n✅ Fuji 装备目录已与 Sepolia 完全一致");
}

main().catch((err) => {
  console.error("❌ 失败:", err.message || err);
  process.exitCode = 1;
});
