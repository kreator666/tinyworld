// 注册演示配件(对应 prototype/role.md 的示例素材),并给指定地址发一套用于联调
// 对应 foundry 脚本 script/SeedParts.s.sol
// 用法: PARTS_ADDRESS=0x... [SEED_TO=0x...] npm run seed:local
require("dotenv").config();
const { ethers, network } = require("hardhat");

// 与 Slots.sol 一致: 0=HEAD 1=BODY 2=ACCESSORY 3=PET
const DEMO_PARTS = [
  { id: 1001, slot: 0, rarity: 0, maxSupply: 10000 }, // head_01   普通
  { id: 1002, slot: 0, rarity: 1, maxSupply: 1000 },  // head_02   稀有
  { id: 2001, slot: 1, rarity: 0, maxSupply: 10000 }, // body_01   普通
  { id: 3001, slot: 2, rarity: 2, maxSupply: 500 },   // acc_ribbon 史诗
  { id: 4001, slot: 3, rarity: 3, maxSupply: 100 },   // pet_cat   传说
];

async function main() {
  const partsAddr = process.env.PARTS_ADDRESS;
  if (!partsAddr) throw new Error("缺少 PARTS_ADDRESS 环境变量(已部署的 DIDParts 地址)");

  const [deployer] = await ethers.getSigners();
  const seedTo = process.env.SEED_TO || deployer.address;
  console.log(`网络:       ${network.name}`);
  console.log(`DIDParts:   ${partsAddr}`);
  console.log(`接收地址:   ${seedTo}`);

  const parts = await ethers.getContractAt("DIDParts", partsAddr);

  for (const p of DEMO_PARTS) {
    const info = await parts.parts(p.id);
    if (info.registered) {
      console.log(`配件 ${p.id} 已注册,跳过`);
      continue;
    }
    const tx = await parts.registerPart(p.id, p.slot, p.rarity, p.maxSupply);
    await tx.wait();
    console.log(`配件 ${p.id} 已注册 (slot=${p.slot}, rarity=${p.rarity}, maxSupply=${p.maxSupply})`);
  }

  const ids = DEMO_PARTS.map((p) => p.id);
  const amounts = DEMO_PARTS.map(() => 1);
  const tx = await parts.mintPartBatch(seedTo, ids, amounts);
  await tx.wait();
  console.log(`已给 ${seedTo} 铸造 ${ids.length} 件演示配件`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
