// 部署装备铸造直售市场 PartsMarket:部署 + 授权 minter + 可选批量上架
// 用法:
//   PARTS_ADDRESS=0x884d... [MARKET_PRICES=1001:0.01,1002:0.01,...] npx hardhat run scripts/deploy-market.js --network avalancheFuji
// 注意:PARTS_ADDRESS 请在命令行显式传入(命令行环境变量优先于 .env,避免 .env 里残留的其他链地址串链)
require("dotenv").config();
const { ethers, network } = require("hardhat");

async function main() {
  const partsAddr = process.env.PARTS_ADDRESS;
  if (!partsAddr) {
    console.error("错误: 缺少 PARTS_ADDRESS 环境变量(已部署的 DIDParts 地址),请显式传入");
    process.exit(1);
  }

  const [deployer] = await ethers.getSigners();
  console.log(`网络:       ${network.name}`);
  console.log(`部署者:     ${deployer.address}`);
  console.log(`DIDParts:   ${partsAddr}`);

  const PartsMarket = await ethers.getContractFactory("PartsMarket");
  const market = await PartsMarket.deploy(partsAddr);
  await market.waitForDeployment();
  const marketAddr = await market.getAddress();
  console.log(`PartsMarket deployed at: ${marketAddr}`);

  // 授权铸造:市场合约只能经 mintPart 的 registered/mintable/maxSupply 约束铸已注册装备
  const parts = await ethers.getContractAt("DIDParts", partsAddr);
  const tx = await parts.setMinter(marketAddr, true);
  const rc = await tx.wait();
  console.log(`已授予 minter 权限: setMinter txHash = ${rc.hash}`);

  // 可选:批量上架 MARKET_PRICES="1001:0.01,2001:0.01,..."
  const raw = process.env.MARKET_PRICES;
  if (raw) {
    const entries = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [id, price] = s.split(":").map((x) => x.trim());
        if (!/^\d+$/.test(id) || !price || isNaN(Number(price)) || Number(price) <= 0) {
          throw new Error(`MARKET_PRICES 格式错误(应为 id:price 逗号分隔): ${s}`);
        }
        return [BigInt(id), ethers.parseEther(price)];
      });
    const tx2 = await market.setPrices(entries.map((e) => e[0]), entries.map((e) => e[1]));
    const rc2 = await tx2.wait();
    console.log(`已上架 ${entries.length} 件(单价 ${raw.split(",")[0].split(":")[1]} 原生币等): setPrices txHash = ${rc2.hash}`);
  }

  console.log(`\n前端配置: fuji market = '${marketAddr}'`);
  console.log(`agent 配置: fuji market = { address: '${marketAddr}' }`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
