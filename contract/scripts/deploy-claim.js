// 部署新手大礼包 v2:StarterPartClaim(随机 4 件套 + 自动穿戴)+ minter 授权
// 可选:DEPLOY_IDENTITY_V2=1 时同时部署新版 DIDIdentity(equip operator 放宽 + equipBatch)并注册配件白名单
// 可选:OLD_CLAIM_ADDRESS=0x... 时撤销旧领取合约的 minter 权限(v1 退役)
// 用法:
//   DEPLOY_IDENTITY_V2=1 PARTS_ADDRESS=0x... npx hardhat run scripts/deploy-claim.js --network avalancheFuji
//   然后(用上一步打印的 IDENTITY):
//   PARTS_ADDRESS=0x... IDENTITY_ADDRESS=0x... OLD_CLAIM_ADDRESS=0x03e5... npx hardhat run scripts/deploy-claim.js --network avalancheFuji
require("dotenv").config();
const { ethers, network } = require("hardhat");

function fail(msg) {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

async function main() {
  const partsAddr = process.env.PARTS_ADDRESS;
  if (!partsAddr) fail("缺少 PARTS_ADDRESS 环境变量(已部署的 DIDParts 地址)");

  const [deployer] = await ethers.getSigners();
  console.log(`网络:       ${network.name}`);
  console.log(`部署者:     ${deployer.address}`);

  // 1) 可选:部署 DIDIdentity v2(equip operator 放宽 + equipBatch)
  let identityAddr = process.env.IDENTITY_ADDRESS;
  if (process.env.DEPLOY_IDENTITY_V2 === "1") {
    const baseURI = process.env.DID_BASE_URI || "https://api.didaiverse.example/metadata/did/";
    const contractURI = process.env.DID_CONTRACT_URI || "https://api.didaiverse.example/metadata/contract.json";
    const DIDIdentity = await ethers.getContractFactory("DIDIdentity");
    const identity = await DIDIdentity.deploy("DID AI Verse Identity", "DIDAI", baseURI, contractURI);
    await identity.waitForDeployment();
    identityAddr = await identity.getAddress();
    console.log(`DIDIdentity v2 deployed at: ${identityAddr}`);
    const tx = await identity.setCollectionApproved(partsAddr, true);
    const rc = await tx.wait();
    console.log(`DIDParts 已注册进新身份合约白名单: setCollectionApproved txHash = ${rc.hash}`);
  }
  if (!identityAddr) fail("缺少 IDENTITY_ADDRESS 环境变量,或用 DEPLOY_IDENTITY_V2=1 现场部署");

  // 2) 部署 StarterPartClaim v2(constructor: parts, identity;随机池 1001-1008/2001-2008/3001-3008/4001-4008 写死)
  console.log(`DIDParts:   ${partsAddr}`);
  console.log(`DIDIdentity:${identityAddr}`);
  const StarterPartClaim = await ethers.getContractFactory("StarterPartClaim");
  const claim = await StarterPartClaim.deploy(partsAddr, identityAddr);
  await claim.waitForDeployment();
  const claimAddr = await claim.getAddress();
  console.log(`StarterPartClaim v2 deployed at: ${claimAddr}`);

  // 3) 授予 minter 权限:本合约只能铸池内 32 个 id(合约内写死校验)
  const parts = await ethers.getContractAt("DIDParts", partsAddr);
  const tx = await parts.setMinter(claimAddr, true);
  const receipt = await tx.wait();
  console.log(`已授予 minter 权限: setMinter txHash = ${receipt.hash}`);

  // 4) 可选:撤销旧领取合约(v1)的 minter 权限
  const oldClaim = process.env.OLD_CLAIM_ADDRESS;
  if (oldClaim) {
    const tx2 = await parts.setMinter(oldClaim, false);
    const rc2 = await tx2.wait();
    console.log(`已撤销旧领取合约 minter 权限(${oldClaim}): txHash = ${rc2.hash}`);
  }

  console.log(`\n前端配置(fuji): identity = ${identityAddr}, partsClaim = ${claimAddr}`);
  console.log(`agent 配置(fuji): identityAddress = '${identityAddr}'`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
