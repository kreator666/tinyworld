// 在 Solana testnet 创建项目自有的测试 USDC(Token-2022, 6 位小数, 符号 tUSDC),
// 并给部署钱包铸 1000 枚。输出 mint 地址供 agent config 使用。
import {
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC = "https://api.testnet.solana.com";
const wallet = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      fs.readFileSync(
        path.join(os.homedir(), ".config", "solana", "id.json"),
        "utf8"
      )
    )
  )
);

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const mint = await createMint(
    conn,
    wallet,
    wallet.publicKey, // mintAuthority
    null, // freezeAuthority
    6,
    undefined,
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
  console.log("tUSDC mint:", mint.toBase58());

  const ata = await getOrCreateAssociatedTokenAccount(
    conn,
    wallet,
    mint,
    wallet.publicKey,
    false,
    "confirmed",
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  await mintTo(
    conn,
    wallet,
    mint,
    ata.address,
    wallet,
    BigInt(1000_000_000_000),
    [],
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
  console.log("已铸 1000 tUSDC 到", wallet.publicKey.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
