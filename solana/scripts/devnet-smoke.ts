// devnet 冒烟测试：initialize_config + mint_identity + 读回验证
// 用法: npx ts-node scripts/devnet-smoke.ts <identityName>
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
  getAccount,
} from "@solana/spl-token";
import { keccak_256 } from "js-sha3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Tinyworld } from "../target/types/tinyworld";

const asciiLower = (s: string) =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const nameHash = (name: string) =>
  Buffer.from(keccak_256.arrayBuffer(Buffer.from(asciiLower(name), "utf8")));

async function main() {
  const name = process.argv[2] ?? "DevnetAlice";
  const connection = new anchor.web3.Connection(
    process.env.CLUSTER_URL ?? "https://api.devnet.solana.com",
    "confirmed"
  );
  const keypairPath =
    process.env.SOLANA_KEYPAIR ??
    path.join(os.homedir(), ".config", "solana", "id.json");
  const wallet = new anchor.Wallet(
    Keypair.fromSecretKey(
      Buffer.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")))
    )
  );
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "tinyworld.json"), "utf8")
  );
  const programId = new PublicKey((idl as any).address ?? idl.metadata.address);
  const program = new Program(idl, provider) as Program<Tinyworld>;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId
  );
  const [mintAuthPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint-auth")],
    programId
  );
  const identity = PublicKey.findProgramAddressSync(
    [Buffer.from("identity"), wallet.publicKey.toBuffer()],
    programId
  )[0];
  const nameRecord = PublicKey.findProgramAddressSync(
    [Buffer.from("name-record"), nameHash(name)],
    programId
  )[0];
  const mint = Keypair.generate();

  // 余额检查（领水失败直接退出）
  const bal = await connection.getBalance(wallet.publicKey);
  console.log("wallet balance:", bal / 1e9, "SOL");
  if (bal < 0.5 * 1e9) {
    console.log("requesting airdrop...");
    const sig = await connection.requestAirdrop(wallet.publicKey, 1e9);
    await connection.confirmTransaction(sig, "confirmed");
  }

  // config（如未初始化）
  const configInfo = await connection.getAccountInfo(configPda);
  if (!configInfo) {
    console.log("initialize_config...");
    const tx = await program.methods
      .initializeConfig()
      .accounts({
        authority: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    console.log("  tx:", tx);
  } else {
    console.log("config already initialized");
  }

  console.log("mint_identity:", name);
  const tx = await program.methods
    .mintIdentity(name)
    .accounts({
      owner: wallet.publicKey,
      nameRecord,
      mint: mint.publicKey,
      ownerAta: getAssociatedTokenAddressSync(
        mint.publicKey,
        wallet.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      ),
      mintAuth: mintAuthPda,
      config: configPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([mint])
    .rpc();
  console.log("  tx:", tx);

  const id = await program.account.identity.fetch(identity);
  const mintInfo = await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
  const tokenAcc = await getAccount(
    connection,
    getAssociatedTokenAddressSync(mint.publicKey, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID),
    "confirmed",
    TOKEN_2022_PROGRAM_ID
  );
  console.log("identity owner:", id.owner.toBase58());
  console.log("identity name:", id.name, "version:", id.version);
  console.log("mint supply:", mintInfo.supply.toString(), "mintAuthority:", mintInfo.mintAuthority?.toBase58());
  console.log("ATA amount:", tokenAcc.amount.toString());
  console.log("SMOKE_OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
