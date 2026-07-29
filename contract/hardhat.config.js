require("@nomicfoundation/hardhat-ethers");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "";
const POLYGON_AMOY_RPC_URL = process.env.POLYGON_AMOY_RPC_URL || "";

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    // 与 foundry.toml 保持一致
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  paths: {
    sources: "./src", // 与 foundry 共用同一套合约源码
    artifacts: "./artifacts",
    // 避免与 foundry 的 cache/solidity-files-cache.json 互相覆盖
    cache: "./cache/hardhat",
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    // 测试网仅在 .env 配齐 RPC + 私钥后启用
    ...(SEPOLIA_RPC_URL && PRIVATE_KEY
      ? { sepolia: { url: SEPOLIA_RPC_URL, accounts: [PRIVATE_KEY] } }
      : {}),
    ...(POLYGON_AMOY_RPC_URL && PRIVATE_KEY
      ? { polygonAmoy: { url: POLYGON_AMOY_RPC_URL, accounts: [PRIVATE_KEY] } }
      : {}),
  },
};
