// Fuji 端到端验证:新手大礼包 v2(随机 4 件套 + 自动穿戴)
// 临时私钥生成测试用户,owner 转一点测试 AVAX;全流程:铸 DID → 两笔授权 → claimPack → 断言四槽已穿
// 注意:地址硬编码为 Fuji 部署(不读 .env,避免 PARTS_ADDRESS 等残留环境变量串链)
// 用法: npx hardhat run scripts/e2e-fuji-starter-pack.js --network avalancheFuji
require("dotenv").config();
const { ethers } = require("hardhat");

const PARTS = "0x884dA9E2E1681Ada159e5DA0ddBb19bc858E0267";
const IDENTITY = "0x38FE7970A66E98C6a1611951d1E7f5f510feE821"; // DIDIdentity v3 (PERMISSION_SKILL)
// TODO: StarterPartClaim 仍指向旧 identity,本脚本在新 identity 下无法完成 claim 自动穿戴,
//       如需跑通请先用新 identity 重新部署 StarterPartClaim 并更新 CLAIM 地址。
const CLAIM = "0x3D98d0Ff048a82a387FDdfF0A4e10a1EF6FBe0f2";

const RANGES = [
  [1001n, 1008n],
  [2001n, 2008n],
  [3001n, 3008n],
  [4001n, 4008n],
];

async function main() {
  const [owner] = await ethers.getSigners();
  const parts = await ethers.getContractAt("DIDParts", PARTS);
  const identity = await ethers.getContractAt("DIDIdentity", IDENTITY);
  const claim = await ethers.getContractAt("StarterPartClaim", CLAIM);

  // 1) 临时测试用户,owner 资助 0.05 AVAX(铸 DID + 两笔授权 + claimPack 足够)
  const user = ethers.Wallet.createRandom().connect(ethers.provider);
  console.log(`测试用户: ${user.address}`);
  const fundTx = await owner.sendTransaction({ to: user.address, value: ethers.parseEther("0.05") });
  await fundTx.wait();
  console.log(`已转 0.05 AVAX: ${fundTx.hash}`);

  // 2) 铸 DID(名称唯一)
  const name = `PackE2E${Date.now() % 1000000}`;
  const mintTx = await identity.connect(user).mint(name, "");
  const mintRc = await mintTx.wait();
  if (mintRc.status !== 1) throw new Error(`铸 DID 失败: ${mintRc.hash}`);
  const tokenId = await identity.tokenIdOf(user.address);
  console.log(`DID 已铸造: '${name}' tokenId=${tokenId}`);

  // 3) 两笔授权:DIDParts 托管 + identity 授权 claim 代为换装
  await parts.connect(user).setApprovalForAll.staticCall(IDENTITY, true); // 先模拟,失败直接拿到 revert 原因
  const appr1 = await parts.connect(user).setApprovalForAll(IDENTITY, true);
  const rc1 = await appr1.wait();
  if (rc1.status !== 1) throw new Error(`setApprovalForAll 失败: ${rc1.hash}`);
  const appr2 = await identity.connect(user).approve(CLAIM, tokenId);
  const rc2 = await appr2.wait();
  if (rc2.status !== 1) throw new Error(`approve 失败: ${rc2.hash}`);
  console.log(`授权完成: setApprovalForAll=${rc1.hash}`);
  console.log(`          approve=${rc2.hash}`);
  console.log(`授权状态回读: parts.isApprovedForAll(user,identity)=${await parts.isApprovedForAll(user.address, IDENTITY)}, identity.getApproved(tokenId)=${await identity.getApproved(tokenId)}`);

  // 4) claimPack
  const tx = await claim.connect(user).claimPack({ gasLimit: 1000000 });
  const receipt = await tx.wait();
  const ev = receipt.logs
    .map((l) => {
      try {
        return claim.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .find((e) => e.name === "StarterPackClaimed");
  if (!ev) throw new Error("缺少 StarterPackClaimed 事件");
  const ids = [...ev.args.partIds];
  console.log(`claimPack 成功: tx=${receipt.hash}`);
  console.log(`  partIds: ${ids.map(String).join(", ")}, dressed=${ev.args.dressed}`);

  // 5) 断言
  if (ev.args.dressed !== true) throw new Error("dressed 应为 true(授权齐全)");
  for (let i = 0; i < 4; i++) {
    const [lo, hi] = RANGES[i];
    if (ids[i] < lo || ids[i] > hi) throw new Error(`槽位 ${i} 的 id ${ids[i]} 不在 [${lo}, ${hi}]`);
  }
  const equipped = await identity.getEquipped(tokenId);
  for (let i = 0; i < 4; i++) {
    if (equipped[i].collection.toLowerCase() !== PARTS.toLowerCase()) throw new Error(`槽位 ${i} 未装备`);
    if (equipped[i].id !== ids[i]) throw new Error(`槽位 ${i} 装备 id 不匹配`);
    const custodial = await parts.balanceOf(IDENTITY, ids[i]);
    if (custodial !== 1n) throw new Error(`identity 未托管装备 ${ids[i]}`);
  }
  if ((await claim.claimed(user.address)) !== true) throw new Error("claimed 应为 true");
  console.log("✅ 端到端断言全部通过:随机 4 件套已自动穿到 DID 上(四槽就位、托管余额正确、claimed 置位)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
