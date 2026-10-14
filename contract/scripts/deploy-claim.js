// 部署 StarterPartClaim(新手装备免费领养)并授予 DIDParts minter 权限
// 用法: PARTS_ADDRESS=0x... IDENTITY_ADDRESS=0x... [CLAIM_POOL_IDS=1001,2001,3001,4001] npx hardhat run scripts/deploy-claim.js --network <net>
require("dotenv").config();
const { ethers, network } = require("hardhat");

function fail(msg) {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

async function main() {
  const partsAddr = process.env.PARTS_ADDRESS;
  const identityAddr = process.env.IDENTITY_ADDRESS;
  if (!partsAddr) fail("缺少 PARTS_ADDRESS 环境变量(已部署的 DIDParts 地址)");
  if (!identityAddr) fail("缺少 IDENTITY_ADDRESS 环境变量(已部署的 DIDIdentity 地址)");

  // 新手池:头/身/配饰/宠物 各一件,默认与 seed.js 的演示配件一致
  const poolIds = (process.env.CLAIM_POOL_IDS || "1001,2001,3001,4001")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (poolIds.length !== 4 || poolIds.some((n) => !Number.isInteger(n) || n <= 0)) {
    fail("CLAIM_POOL_IDS 必须是 4 个正整数,逗号分隔");
  }

  const [deployer] = await ethers.getSigners();
  console.log(`网络:       ${network.name}`);
  console.log(`部署者:     ${deployer.address}`);
  console.log(`DIDParts:   ${partsAddr}`);
  console.log(`DIDIdentity:${identityAddr}`);
  console.log(`新手池:     ${poolIds.join(", ")}`);

  const StarterPartClaim = await ethers.getContractFactory("StarterPartClaim");
  const claim = await StarterPartClaim.deploy(partsAddr, identityAddr, poolIds);
  await claim.waitForDeployment();
  const claimAddr = await claim.getAddress();
  console.log(`StarterPartClaim deployed at: ${claimAddr}`);

  // 授予 minter 权限:本合约只能铸池内 4 个 id(合约内写死校验)
  const parts = await ethers.getContractAt("DIDParts", partsAddr);
  const tx = await parts.setMinter(claimAddr, true);
  const receipt = await tx.wait();
  console.log(`已授予 minter 权限: setMinter txHash = ${receipt.hash}`);

  console.log(`\n前端配置(chains 表 config.partsClaim / web partsClaim 字段): ${claimAddr}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
