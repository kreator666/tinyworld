// 部署 DIDParts + DIDIdentity,并把配件合约注册进身份合约白名单
// 对应 foundry 脚本 script/Deploy.s.sol
// 用法: npm run deploy:local / deploy:sepolia / deploy:amoy
require("dotenv").config();
const { ethers, network } = require("hardhat");

async function main() {
  const baseURI = process.env.DID_BASE_URI || "https://api.didaiverse.example/metadata/did/";
  const contractURI =
    process.env.DID_CONTRACT_URI || "https://api.didaiverse.example/metadata/contract.json";
  const partsURI = process.env.PARTS_BASE_URI || "https://api.didaiverse.example/parts/{id}.json";

  const [deployer] = await ethers.getSigners();
  console.log(`网络:       ${network.name}`);
  console.log(`部署者:     ${deployer.address}`);

  const DIDParts = await ethers.getContractFactory("DIDParts");
  const parts = await DIDParts.deploy(partsURI);
  await parts.waitForDeployment();
  const partsAddr = await parts.getAddress();
  console.log(`DIDParts    deployed at: ${partsAddr}`);

  const DIDIdentity = await ethers.getContractFactory("DIDIdentity");
  const identity = await DIDIdentity.deploy("DID AI Verse Identity", "DIDAI", baseURI, contractURI);
  await identity.waitForDeployment();
  const identityAddr = await identity.getAddress();
  console.log(`DIDIdentity deployed at: ${identityAddr}`);

  const tx = await identity.setCollectionApproved(partsAddr, true);
  await tx.wait();
  console.log(`DIDParts 已注册进 DIDIdentity 配件白名单`);
  console.log(`\n下一步播种(注册演示配件):\n  PARTS_ADDRESS=${partsAddr} npm run seed:local`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
