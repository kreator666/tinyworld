// 升级后链上验证(testnet):set_mint_fee 收费铸造 + close_identity 释放名字
// 用法: CLUSTER_URL=https://api.testnet.solana.com npx ts-node scripts/verify-upgrade.ts
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
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
  const connection = new anchor.web3.Connection(
    process.env.CLUSTER_URL ?? "https://api.testnet.solana.com",
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
    fs.readFileSync(
      path.join(__dirname, "..", "target", "idl", "tinyworld.json"),
      "utf8"
    )
  );
  // anchor 0.31 IDL:程序地址在顶层 address(旧版在 metadata.address)
  const programId = new PublicKey((idl as any).address ?? idl.metadata?.address);
  const program = new Program(idl, provider) as Program<Tinyworld>;

  const configPda = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId
  )[0];
  const mintAuthPda = PublicKey.findProgramAddressSync(
    [Buffer.from("mint-auth")],
    programId
  )[0];
  const nameRecordPda = (name: string) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("name-record"), nameHash(name)],
      programId
    )[0];

  // 1. 设置费率 0.001 SOL
  const FEE = new BN(1_000_000);
  await program.methods
    .setMintFee(FEE)
    .accounts({ authority: wallet.publicKey } as any)
    .rpc();
  console.log("1. set_mint_fee 0.001 SOL ✓");

  // 2. 收费铸造(带 fee_receiver)。水龙头常限流,直接从部署钱包转测试费
  const testWallet = Keypair.generate();
  const fundTx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: testWallet.publicKey,
      lamports: 1e8, // 0.1 SOL:覆盖铸造租金 + 0.001 费率
    })
  );
  fundTx.feePayer = wallet.publicKey;
  fundTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  fundTx.sign((wallet as any).payer ?? wallet);
  const fundSig = await connection.sendRawTransaction(fundTx.serialize());
  await connection.confirmTransaction(fundSig, "confirmed");
  const testName = `Vu${Date.now().toString(36)}x${Math.floor(Math.random() * 36 ** 3).toString(36)}`;
  console.log("testName:", testName, "| nameRecord 已占用:", (await connection.getAccountInfo(nameRecordPda(testName))) !== null);
  const mint = Keypair.generate();
  const identity = PublicKey.findProgramAddressSync(
    [Buffer.from("identity"), testWallet.publicKey.toBuffer()],
    programId
  )[0];
  const authBefore = await connection.getBalance(wallet.publicKey);
  await program.methods
    .mintIdentity(testName)
    .accounts({
      owner: testWallet.publicKey,
      identity,
      nameRecord: nameRecordPda(testName),
      mint: mint.publicKey,
      ownerAta: getAssociatedTokenAddressSync(
        mint.publicKey,
        testWallet.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      ),
      mintAuth: mintAuthPda,
      config: configPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      feeReceiver: wallet.publicKey,
    } as any)
    .signers([testWallet, mint])
    .rpc();
  const authAfter = await connection.getBalance(wallet.publicKey);
  console.log(
    `2. 收费铸造 ✓ authority 净收入 ≈ ${((authAfter - authBefore) / 1e9).toFixed(6)} SOL(应≈0.001-交易费)`
  );

  // 3. 费率>0 时不传 fee_receiver(程序 ID 占位) → 应失败。用第二个钱包(每钱包限 1 枚)
  const testWallet2 = Keypair.generate();
  const fund2Tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: testWallet2.publicKey,
      lamports: 1e8,
    })
  );
  fund2Tx.feePayer = wallet.publicKey;
  fund2Tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  fund2Tx.sign((wallet as any).payer ?? wallet);
  const fund2Sig = await connection.sendRawTransaction(fund2Tx.serialize());
  await connection.confirmTransaction(fund2Sig, "confirmed");
  const mint2 = Keypair.generate();
  const testName2 = `Vu2${Date.now().toString(36).slice(-6)}`;
  try {
    await program.methods
      .mintIdentity(testName2)
      .accounts({
        owner: testWallet2.publicKey,
        identity: PublicKey.findProgramAddressSync(
          [Buffer.from("identity"), testWallet2.publicKey.toBuffer()],
          programId
        )[0],
        nameRecord: nameRecordPda(testName2),
        mint: mint2.publicKey,
        ownerAta: getAssociatedTokenAddressSync(
          mint2.publicKey,
          testWallet2.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        ),
        mintAuth: mintAuthPda,
        config: configPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeReceiver: program.programId,
      } as any)
      .signers([testWallet2, mint2])
      .rpc();
    throw new Error("应当失败却没有");
  } catch (e: any) {
    if (`${e?.message ?? ""} ${(e?.logs ?? []).join(" ")}`.includes("MintFeeReceiverRequired"))
      console.log("3. 缺 fee_receiver 被拒 ✓");
    else throw e;
  }

  // 4. 关闭身份 → 名字应释放
  await program.methods
    .closeIdentity()
    .accounts({
      identity,
      nameRecord: nameRecordPda(testName),
      signer: testWallet.publicKey,
      identityMint: mint.publicKey,
      ownerAta: getAssociatedTokenAddressSync(
        mint.publicKey,
        testWallet.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      ),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    } as any)
    .signers([testWallet])
    .rpc();
  const nr = await connection.getAccountInfo(nameRecordPda(testName));
  if (nr !== null) throw new Error("name_record 未释放!");
  console.log("4. close_identity 释放名字 ✓");

  // 5. 费率归零,恢复免费(传程序 ID 占位即可)
  await program.methods
    .setMintFee(new BN(0))
    .accounts({ authority: wallet.publicKey } as any)
    .rpc();
  console.log("5. 费率归零 ✓");
  console.log("VERIFY_UPGRADE_OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
