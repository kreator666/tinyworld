// 主网部署 gas 估算:anvil 主网 fork 上完整模拟
//   部署 DIDIdentity + DIDParts + DIDReputation + DIDValidation
//   + setCollectionApproved + registerPartBatch(120) + 创世 mintPartBatch(每槽 2985 份,全给 owner)
// 输出每笔 gas 与汇总;不打印任何私钥(anvil 默认账户仅 fork 本地有效)
const { ethers } = require("ethers");

const RPC = "http://localhost:8545";
const abiOf = (name) => require(`../out/${name}.sol/${name}.json`).abi;
const byteOf = (name) => {
  const b = require(`../out/${name}.sol/${name}.json`).bytecode.object;
  return b.startsWith("0x") ? b : "0x" + b;
};
const IDENTITY_ABI = abiOf("DIDIdentity");
const PARTS_ABI = abiOf("DIDParts");
const REP_ABI = abiOf("DIDReputation");
const VAL_ABI = abiOf("DIDValidation");

// 随机生成 fork 专用钱包(私钥不落盘不打印),anvil_setBalance 注资,避开默认账户在主网上的历史 nonce
const OWNER_KEY = "0x" + require("crypto").randomBytes(32).toString("hex");
const OWNER_WALLET = new (require("ethers").Wallet)(OWNER_KEY);
const OWNER = OWNER_WALLET.address;

async function run() {
  const provider = new ethers.JsonRpcProvider(RPC);
  // 注资 + 清 nonce(防御该地址在主网有历史)
  await provider.send("anvil_setBalance", [OWNER, "0x3635C9ADC5DEA00000"]); // 1000 AVAX
  await provider.send("anvil_setNonce", [OWNER, "0x0"]);
  const owner = new ethers.Wallet(OWNER_KEY, provider);
  let nextNonce = await provider.getTransactionCount(OWNER, "pending");
  const rawSend = owner.sendTransaction.bind(owner);
  owner.sendTransaction = (tx) => rawSend({ ...tx, nonce: nextNonce++ });
  const txs = [];
  const GAS = { deploy: 10_000_000, approve: 200_000, register: 8_000_000, mint: 12_000_000 };
const track = async (label, txPromise) => {
    const tx = await txPromise;
    const receipt = await tx.wait();
    txs.push({ label, gas: receipt.gasUsed });
    console.log(`${label}: gas=${receipt.gasUsed}`);
    return receipt;
  };
  const factory = (abi, name) => new ethers.ContractFactory(abi, byteOf(name), owner);

  const partsDeploy = await factory(PARTS_ABI, "DIDParts").deploy("https://api.didaiverse.example/parts/{id}.json", { gasLimit: GAS.deploy });
  const partsAddr = await (await track("部署 DIDParts", Promise.resolve(partsDeploy.deploymentTransaction()))).contractAddress;
  const parts = new ethers.Contract(partsAddr, PARTS_ABI, owner);

  const identityDeploy = await factory(IDENTITY_ABI, "DIDIdentity").deploy(
    "DID AI Verse Identity", "DIDAI",
    "https://api.didaiverse.example/metadata/did/",
    "https://api.didaiverse.example/metadata/contract.json",
    { gasLimit: GAS.deploy },
  );
  const identityAddr = (await track("部署 DIDIdentity", Promise.resolve(identityDeploy.deploymentTransaction()))).contractAddress;
  const identity = new ethers.Contract(identityAddr, IDENTITY_ABI, owner);

  const repDeploy = await factory(REP_ABI, "DIDReputation").deploy(identityAddr, { gasLimit: GAS.deploy });
  const repAddr = (await track("部署 DIDReputation", Promise.resolve(repDeploy.deploymentTransaction()))).contractAddress;

  const valDeploy = await factory(VAL_ABI, "DIDValidation").deploy(identityAddr, { gasLimit: GAS.deploy });
  const valAddr = (await track("部署 DIDValidation", Promise.resolve(valDeploy.deploymentTransaction()))).contractAddress;

  // ② 白名单
  await track("setCollectionApproved", identity.setCollectionApproved(partsAddr, true, { gasLimit: GAS.approve }));

  // ③ registerPartBatch(120)
  const COUNT = 30;
  const supplies = [10000n, 2000n, 500n, 100n];
  const ids = [], slots = [], rarities = [], maxSupplies = [];
  for (let slot = 0; slot < 4; slot++) {
    const base = (slot + 1) * 1000;
    for (let i = 0; i < COUNT; i++) {
      const r = i < 12 ? 0 : i < 21 ? 1 : i < 27 ? 2 : 3;
      ids.push(base + 1 + i); slots.push(slot); rarities.push(r); maxSupplies.push(supplies[r]);
    }
  }
  await track("registerPartBatch(120)", parts.registerPartBatch(ids, slots, rarities, maxSupplies, { gasLimit: GAS.register }));

  // ④ 创世铸造:每槽 普通12×200 + 稀有9×50 + 史诗6×20 + 传说3×5 = 2985,全给 owner;分笔(每槽一笔)
  const amountsOf = () => { const a = []; for (let i = 0; i < COUNT; i++) a.push(i < 12 ? 200n : i < 21 ? 50n : i < 27 ? 20n : 5n); return a; };
  let mintTxs = 0;
  for (let slot = 0; slot < 4; slot++) {
    const base = (slot + 1) * 1000;
    const mIds = [], mAmounts = [];
    for (let i = 0; i < COUNT; i++) { mIds.push(base + 1 + i); }
    const amounts = amountsOf();
    const r = await track(`mintPartBatch slot${slot}(30 id × ${amounts.reduce((x,y)=>x+y,0n)} 份)`, parts.mintPartBatch(OWNER, mIds, amounts, { gasLimit: GAS.mint }));
    mintTxs++;
  }

  // 汇总
  const total = txs.reduce((s, t) => s + t.gas, 0n);
  console.log("\n===== 汇总 =====");
  console.log("交易笔数:", txs.length, `(含创世铸造 ${mintTxs} 笔)`);
  console.log("总 gas:", total.toString());
  // 主网实时 baseFee(直接读主网 RPC,fork 的 baseFee 不代表现网)
  const mainnet = new ethers.JsonRpcProvider("https://avalanche-c-chain-rpc.publicnode.com");
  const block = await mainnet.getBlock("latest");
  const baseFee = block.baseFeePerGas;
  const gasPrice = baseFee * 2n; // 2 倍 base fee 安全边际
  console.log("主网 baseFeePerGas:", baseFee.toString(), "wei =", ethers.formatUnits(baseFee, "gwei"), "gwei");
  console.log("估算 gasPrice(2x base fee):", ethers.formatUnits(gasPrice, "gwei"), "gwei");
  const costWei = total * gasPrice;
  console.log("估算成本:", ethers.formatEther(costWei), "AVAX");
  const suggest = Number(ethers.formatEther(costWei)) * 2;
  console.log("建议充值(成本×2 向上取整):", Math.ceil(suggest), "AVAX");
}

run().catch((e) => { console.error(e); process.exit(1); });
