import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
  createAssociatedTokenAccount,
  transferChecked,
  AuthorityType,
  setAuthority,
} from "@solana/spl-token";
import { keccak_256 } from "js-sha3";
import { assert } from "chai";
import { Tinyworld } from "../target/types/tinyworld";

const asciiLower = (s: string) =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const nameHash = (name: string) =>
  Buffer.from(keccak_256.arrayBuffer(Buffer.from(asciiLower(name), "utf8")));

const TOKEN_PROGRAM = TOKEN_2022_PROGRAM_ID;

describe("tinyworld", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Tinyworld as Program<Tinyworld>;
  const authority = provider.wallet; // 程序部署者 / config authority

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [mintAuthPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint-auth")],
    program.programId
  );

  const identityPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("identity"), owner.toBuffer()],
      program.programId
    )[0];
  const nameRecordPda = (name: string) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("name-record"), nameHash(name)],
      program.programId
    )[0];
  const partConfigPda = (partId: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("part"), new BN(partId).toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  const minterPda = (wallet: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("minter"), wallet.toBuffer()],
      program.programId
    )[0];
  const agentPermissionPda = (identity: PublicKey, agent: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("agent-permission"), identity.toBuffer(), agent.toBuffer()],
      program.programId
    )[0];
  const ata = (owner: PublicKey, mint: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM);

  // 本地 validator 的 airdrop RPC 在本机不可用（Internal error），
  // 改用 genesis 已充值的 provider 钱包直接转账。
  const newWallet = async () => {
    const w = Keypair.generate();
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: w.publicKey,
        lamports: 2 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx);
    return w;
  };

  // 铸身份（通用）。feeReceiver:费率>0 时传接收账户(必须=config authority);默认传程序 ID = None
  const mintIdentity = async (wallet: Keypair, name: string, feeReceiver?: PublicKey) => {
    const mint = Keypair.generate();
    const identity = identityPda(wallet.publicKey);
    const tx = await program.methods
      .mintIdentity(name)
      .accounts({
        owner: wallet.publicKey,
        identity,
        nameRecord: nameRecordPda(name),
        mint: mint.publicKey,
        ownerAta: ata(wallet.publicKey, mint.publicKey),
        mintAuth: mintAuthPda,
        config: configPda,
        tokenProgram: TOKEN_PROGRAM,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeReceiver: feeReceiver ?? program.programId, // Option 占位:程序 ID = None(费率=0 时)
      })
      .signers([wallet, mint])
      .rpc();
    return { mint, identity, tx };
  };

  const fetchIdentity = (identity: PublicKey) =>
    program.account.identity.fetch(identity);

  const expectErr = async (p: Promise<unknown>, code: string) => {
    try {
      await p;
      assert.fail(`expected error ${code}`);
    } catch (e: any) {
      const msg = `${e?.message ?? ""} ${(e?.logs ?? []).join(" ")}`;
      assert.include(msg, code, `expected ${code}, got: ${msg}`);
    }
  };

  let alice: Keypair;
  let bob: Keypair;
  let carol: Keypair;
  let dave: Keypair;

  const aliceIdentityMint = { mint: null as PublicKey, identity: null as PublicKey };

  before(async () => {
    // 初始化 config（deploy 时一次性）
    await program.methods
      .initializeConfig()
      .accounts({
        config: configPda,
        mintAuth: mintAuthPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    alice = await newWallet();
    bob = await newWallet();
    carol = await newWallet();
    dave = await newWallet();
  });

  // ------------------------------------------------------------------
  // 1. 正常铸造
  // ------------------------------------------------------------------
  it("正常铸造：supply=1、ATA 持有、Identity/NameRecord 字段正确", async () => {
    const { mint, identity } = await mintIdentity(alice, "Alice");
    aliceIdentityMint.mint = mint.publicKey;
    aliceIdentityMint.identity = identity;

    const mintInfo = await getMint(provider.connection, mint.publicKey, undefined, TOKEN_PROGRAM);
    assert.equal(mintInfo.supply.toString(), "1");
    assert.equal(mintInfo.decimals, 0);
    assert.isTrue(mintInfo.mintAuthority.equals(mintAuthPda));
    assert.isNull(mintInfo.freezeAuthority);

    const tokenAcc = await getAccount(provider.connection, ata(alice.publicKey, mint.publicKey), undefined, TOKEN_PROGRAM);
    assert.equal(tokenAcc.amount.toString(), "1");

    const id = await fetchIdentity(identity);
    assert.isTrue(id.owner.equals(alice.publicKey));
    assert.isTrue(id.mint.equals(mint.publicKey));
    assert.equal(id.name, "Alice");
    assert.deepEqual([...id.nameHash], [...nameHash("Alice")]);
    assert.deepEqual([...id.personaHash], new Array(32).fill(0));
    assert.equal(id.personaArweaveId, "");
    assert.deepEqual(id.equipped, [null, null, null, null]);
    assert.equal(id.agentCount, 0);
    assert.equal(id.recipeId.toNumber(), 0);
    assert.equal(id.mintFeeLamports.toNumber(), 0);
    assert.equal(id.readyAt.toNumber(), 0);
    assert.deepEqual([...id.attributes], new Array(32).fill(0));
    assert.equal(id.version, 1);
    assert.deepEqual([...id.reserved], new Array(128).fill(0));

    // NameRecord 未作为 Account<T> 出现在任何上下文，IDL 不含其类型，直接校验原始字节
    const nrInfo = await provider.connection.getAccountInfo(nameRecordPda("Alice"));
    assert.isNotNull(nrInfo);
    const nrData = nrInfo.data;
    assert.isTrue(new PublicKey(nrData.subarray(8, 40)).equals(alice.publicKey));
    assert.isTrue(new PublicKey(nrData.subarray(40, 72)).equals(identity));
    assert.isTrue(new BN(nrData.subarray(72, 80), "le").gt(new BN(0)));
  });

  it("账户空间：Identity 大于实际字段和、预留字段存在", async () => {
    const info = await provider.connection.getAccountInfo(aliceIdentityMint.identity);
    // 实际字段和（不含 256 冗余）≈ 602 + 名称长度调整；空间必须 > 字段和
    assert.isTrue(info.data.length > 602 + 256 - 258); // 858 - name_len
    const id = await fetchIdentity(aliceIdentityMint.identity);
    assert.equal(id.reserved.length, 128);
  });

  // ------------------------------------------------------------------
  // 2. Soulbound
  // ------------------------------------------------------------------
  it("铸造即 Soulbound：transfer 身份代币必须失败", async () => {
    const mint = aliceIdentityMint.mint;
    const payer: any = (authority as any).payer ?? authority;
    // 收款方 ATA 也必须是 token-2022 体系
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      bob.publicKey,
      false,
      TOKEN_PROGRAM
    );
    await expectErr(
      transferChecked(
        provider.connection,
        payer,
        ata(alice.publicKey, mint),
        mint,
        recipientAta,
        alice,
        1,
        0,
        [],
        {},
        TOKEN_PROGRAM
      ),
      // token-2022 NonTransferable 扩展生效：日志为 "Transfer is disabled for this mint"
      "disabled for this mint"
    );
  });

  // ------------------------------------------------------------------
  // 3/4/5. 重复铸造 / 重名 / 名称长度
  // ------------------------------------------------------------------
  it("同一钱包铸第二枚失败（AlreadyHasDID）", async () => {
    await expectErr(mintIdentity(alice, "AliceII"), "AlreadyHasDID");
  });

  it("重名失败（大小写不敏感）：Bob 铸 \"alice\" 失败（NameTaken）", async () => {
    await expectErr(mintIdentity(bob, "alice"), "NameTaken");
  });

  it("超长名（>64B）/空名失败（InvalidName）", async () => {
    await expectErr(mintIdentity(bob, "a".repeat(65)), "InvalidName");
    await expectErr(mintIdentity(bob, ""), "InvalidName");
  });

  // ------------------------------------------------------------------
  // 6. persona + agent 授权
  // ------------------------------------------------------------------
  it("owner 改 persona 成功；arweave_id 校验", async () => {
    const hash = Buffer.from(keccak_256.arrayBuffer(Buffer.from("persona-json")));
    const arweaveId = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN_-0"; // 43 chars
    assert.equal(arweaveId.length, 43);
    await program.methods
      .updatePersona([...hash], arweaveId)
      .accounts({
        identity: aliceIdentityMint.identity,
        signer: alice.publicKey,
        agentPermission: null,
      })
      .signers([alice])
      .rpc();
    const id = await fetchIdentity(aliceIdentityMint.identity);
    assert.deepEqual([...id.personaHash], [...hash]);
    assert.equal(id.personaArweaveId, arweaveId);

    // 非法 arweave id 失败
    await expectErr(
      program.methods
        .updatePersona([...hash], "bad!")
        .accounts({
          identity: aliceIdentityMint.identity,
          signer: alice.publicKey,
          agentPermission: null,
        })
        .signers([alice])
        .rpc(),
      "InvalidArweaveId"
    );
  });

  it("agent（PERMISSION_PERSONA）改 persona 成功；未授权第三方失败；revoke 后失败", async () => {
    const identity = aliceIdentityMint.identity;
    const agent = carol;
    const hash = [...Buffer.from(keccak_256.arrayBuffer(Buffer.from("agent-persona")))];

    // 非法权限位（bit2）失败
    await expectErr(
      program.methods
        .setAgent(agent.publicKey, 4)
        .accounts({
          identity,
          owner: alice.publicKey,
          agent: agent.publicKey,
          agentPermission: agentPermissionPda(identity, agent.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc(),
      "InvalidAgentPermission"
    );

    await program.methods
      .setAgent(agent.publicKey, 1)
      .accounts({
        identity,
        owner: alice.publicKey,
        agent: agent.publicKey,
        agentPermission: agentPermissionPda(identity, agent.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([alice])
      .rpc();
    let id = await fetchIdentity(identity);
    assert.equal(id.agentCount, 1);

    // agent 改 persona
    await program.methods
      .updatePersona(hash, "")
      .accounts({
        identity,
        signer: agent.publicKey,
        agentPermission: agentPermissionPda(identity, agent.publicKey),
      })
      .signers([agent])
      .rpc();
    id = await fetchIdentity(identity);
    assert.deepEqual([...id.personaHash], hash);

    // 未授权第三方失败
    await expectErr(
      program.methods
        .updatePersona(hash, "")
        .accounts({
          identity,
          signer: dave.publicKey,
          agentPermission: null,
        })
        .signers([dave])
        .rpc(),
      "NotAuthorized"
    );

    // revoke 后 agent 再改失败
    await program.methods
      .revokeAgent(agent.publicKey)
      .accounts({
        identity,
        owner: alice.publicKey,
        agent: agent.publicKey,
        agentPermission: agentPermissionPda(identity, agent.publicKey),
      })
      .signers([alice])
      .rpc();
    id = await fetchIdentity(identity);
    assert.equal(id.agentCount, 0);
    const permInfo = await provider.connection.getAccountInfo(
      agentPermissionPda(identity, agent.publicKey)
    );
    assert.isNull(permInfo); // close = 账户已关闭

    await expectErr(
      program.methods
        .updatePersona(hash, "")
        .accounts({
          identity,
          signer: agent.publicKey,
          agentPermission: null,
        })
        .signers([agent])
        .rpc(),
      "NotAuthorized"
    );
  });

  // ------------------------------------------------------------------
  // 7. register_part
  // ------------------------------------------------------------------
  const HEAD = 1001;
  const HEAD2 = 1002;
  const BODY = 2001;
  const parts: Record<number, PublicKey> = {};

  it("register_part 非 authority 失败；正常注册字段正确", async () => {
    const fakeMint = Keypair.generate();
    await expectErr(
      program.methods
        .registerPart(new BN(HEAD), 0, 1, new BN(3))
        .accounts({
          config: configPda,
          authority: bob.publicKey,
          partConfig: partConfigPda(HEAD),
          partMint: fakeMint.publicKey,
          mintAuth: mintAuthPda,
          tokenProgram: TOKEN_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .signers([bob, fakeMint])
        .rpc(),
      "Unauthorized"
    );

    const mint = Keypair.generate();
    await program.methods
      .registerPart(new BN(HEAD), 0, 1, new BN(3))
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        partConfig: partConfigPda(HEAD),
        partMint: mint.publicKey,
        mintAuth: mintAuthPda,
        tokenProgram: TOKEN_PROGRAM,
        systemProgram: SystemProgram.programId,
      })
      .signers([mint])
      .rpc();
    parts[HEAD] = mint.publicKey;

    const cfg = await program.account.partConfig.fetch(partConfigPda(HEAD));
    assert.equal(cfg.partId.toNumber(), HEAD);
    assert.isTrue(cfg.mint.equals(mint.publicKey));
    assert.equal(cfg.slot, 0);
    assert.equal(cfg.rarity, 1);
    assert.equal(cfg.maxSupply.toNumber(), 3);
    assert.isTrue(cfg.mintable);
    assert.isTrue(cfg.registeredAt.gt(new BN(0)));

    // 重复注册失败
    const mint2 = Keypair.generate();
    await expectErr(
      program.methods
        .registerPart(new BN(HEAD), 0, 1, new BN(3))
        .accounts({
          config: configPda,
          authority: authority.publicKey,
          partConfig: partConfigPda(HEAD),
          partMint: mint2.publicKey,
          mintAuth: mintAuthPda,
          tokenProgram: TOKEN_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .signers([mint2])
        .rpc(),
      "PartAlreadyRegistered"
    );

    // 其余部件
    for (const [id, slot] of [[HEAD2, 0], [BODY, 1]] as const) {
      const m = Keypair.generate();
      await program.methods
        .registerPart(new BN(id), slot, 2, new BN(2))
        .accounts({
          config: configPda,
          authority: authority.publicKey,
          partConfig: partConfigPda(id),
          partMint: m.publicKey,
          mintAuth: mintAuthPda,
          tokenProgram: TOKEN_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .signers([m])
        .rpc();
      parts[id] = m.publicKey;
    }
  });

  // ------------------------------------------------------------------
  // 8. mint_part
  // ------------------------------------------------------------------
  it("mint_part：非 minter 失败；set_minter 后成功；max_supply 边界；set_mintable(false) 后失败", async () => {
    const mintPart = (signer: Keypair, partId: number, to: PublicKey, amount: number) =>
      program.methods
        .mintPart(new BN(partId), to, new BN(amount))
        .accounts({
          config: configPda,
          signer: signer.publicKey,
          minter: minterPda(signer.publicKey),
          partConfig: partConfigPda(partId),
          partMint: parts[partId],
          to,
          toAta: ata(to, parts[partId]),
          mintAuth: mintAuthPda,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([signer])
        .rpc();

    // 非 minter（bob）失败
    await expectErr(mintPart(bob, HEAD, bob.publicKey, 1), "UnauthorizedMinter");

    // authority 本人铸造成功
    await mintPartKeypair(HEAD, alice.publicKey, 1);

    // set_minter(bob) 后 bob 可铸
    await program.methods
      .setMinter(true)
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        wallet: bob.publicKey,
        minter: minterPda(bob.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await mintPart(bob, HEAD, alice.publicKey, 1); // supply=2

    // 边界：max=3，再铸 1 成功（铸满），+1 失败
    await mintPart(bob, HEAD, alice.publicKey, 1); // supply=3
    let mintInfo = await getMint(provider.connection, parts[HEAD], undefined, TOKEN_PROGRAM);
    assert.equal(mintInfo.supply.toString(), "3");
    await expectErr(mintPart(bob, HEAD, alice.publicKey, 1), "ExceedsMaxSupply");

    // set_mintable(false) 后失败
    await program.methods
      .setPartMintable(new BN(HEAD), false)
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        partConfig: partConfigPda(HEAD),
      })
      .rpc();
    await expectErr(mintPart(bob, HEAD, alice.publicKey, 1), "NotMintable");
    await program.methods
      .setPartMintable(new BN(HEAD), true)
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        partConfig: partConfigPda(HEAD),
      })
      .rpc();

    // alice 现在持有 3 个 HEAD
    async function mintPartKeypair(partId: number, to: PublicKey, amount: number) {
      await program.methods
        .mintPart(new BN(partId), to, new BN(amount))
        .accounts({
          config: configPda,
          signer: authority.publicKey,
          minter: minterPda(authority.publicKey),
          partConfig: partConfigPda(partId),
          partMint: parts[partId],
          to,
          toAta: ata(to, parts[partId]),
          mintAuth: mintAuthPda,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  });

  // ------------------------------------------------------------------
  // 9. equip / unequip
  // ------------------------------------------------------------------
  it("equip：未注册 part 失败；slot 不匹配失败；正常 equip；自动换装（EVM 语义）；unequip", async () => {
    const identity = aliceIdentityMint.identity;

    const equipTx = async (
      signer: Keypair,
      partId: number,
      slot: number,
      old?: { mint: PublicKey }
    ) => {
      const mint = parts[partId];
      const oldMint = old?.mint ?? null;
      return program.methods
        .equip(new BN(partId), slot)
        .accounts({
          identity,
          signer: signer.publicKey,
          partConfig: partConfigPda(partId),
          partMint: mint,
          ownerAta: ata(signer.publicKey, mint),
          escrowAta: ata(identity, mint),
          oldPartMint: oldMint,
          oldEscrowAta: oldMint ? ata(identity, oldMint) : null,
          oldOwnerAta: oldMint ? ata(signer.publicKey, oldMint) : null,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([signer])
        .rpc();
    };

    // 未注册 part 失败（partConfig PDA 不存在 → anchor AccountNotInitialized 或找不到）
    {
      const fakeId = 9999;
      const fakeMint = Keypair.generate();
      try {
        await program.methods
          .equip(new BN(fakeId), 0)
          .accounts({
            identity,
            signer: alice.publicKey,
            partConfig: partConfigPda(fakeId),
            partMint: fakeMint.publicKey,
            ownerAta: ata(alice.publicKey, fakeMint.publicKey),
            escrowAta: ata(identity, fakeMint.publicKey),
            oldPartMint: null,
            oldEscrowAta: null,
            oldOwnerAta: null,
            tokenProgram: TOKEN_PROGRAM,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc();
        assert.fail("expected error");
      } catch (e: any) {
        assert.isOk(e, "expected an error for unregistered part");
      }
    }

    // slot 不匹配：HEAD 是 slot 0，请求 slot 1 失败
    await expectErr(equipTx(alice, HEAD, 1), "SlotMismatch");

    // 非 owner 失败
    await expectErr(equipTx(bob, HEAD, 0), "NotTokenOwner");

    // 正常 equip slot 0
    await equipTx(alice, HEAD, 0);
    let id = await fetchIdentity(identity);
    assert.isTrue(id.equipped[0].equals(parts[HEAD]));
    let escrow = await getAccount(provider.connection, ata(identity, parts[HEAD]), undefined, TOKEN_PROGRAM);
    assert.equal(escrow.amount.toString(), "1");
    assert.isTrue(escrow.owner.equals(identity));

    // EVM 语义：同 slot 二次 equip = 自动换装（旧件退回，新件入托管）
    await mintToHead2(alice.publicKey, 1);
    await equipTx(alice, HEAD2, 0, { mint: parts[HEAD] });
    id = await fetchIdentity(identity);
    assert.isTrue(id.equipped[0].equals(parts[HEAD2]));
    const oldOwnerAcc = await getAccount(provider.connection, ata(alice.publicKey, parts[HEAD]), undefined, TOKEN_PROGRAM);
    assert.equal(oldOwnerAcc.amount.toString(), "3"); // 原有 2 + 退回 1（alice 共持有 3 个 HEAD）
    escrow = await getAccount(provider.connection, ata(identity, parts[HEAD2]), undefined, TOKEN_PROGRAM);
    assert.equal(escrow.amount.toString(), "1");

    // equip 其余插槽
    await mintBody(alice.publicKey, 1);
    await equipTx(alice, BODY, 1);
    id = await fetchIdentity(identity);
    assert.isTrue(id.equipped[1].equals(parts[BODY]));

    // unequip slot 1
    await program.methods
      .unequip(1)
      .accounts({
        identity,
        signer: alice.publicKey,
        partMint: parts[BODY],
        escrowAta: ata(identity, parts[BODY]),
        ownerAta: ata(alice.publicKey, parts[BODY]),
        tokenProgram: TOKEN_PROGRAM,
      })
      .signers([alice])
      .rpc();
    id = await fetchIdentity(identity);
    assert.isNull(id.equipped[1]);
    const bodyAcc = await getAccount(provider.connection, ata(alice.publicKey, parts[BODY]), undefined, TOKEN_PROGRAM);
    assert.equal(bodyAcc.amount.toString(), "1");

    // 空插槽 unequip 失败
    await expectErr(
      program.methods
        .unequip(1)
        .accounts({
          identity,
          signer: alice.publicKey,
          partMint: parts[BODY],
          escrowAta: ata(identity, parts[BODY]),
          ownerAta: ata(alice.publicKey, parts[BODY]),
          tokenProgram: TOKEN_PROGRAM,
        })
        .signers([alice])
        .rpc(),
      "NothingEquipped"
    );

    async function mintToHead2(to: PublicKey, amount: number) {
      await program.methods
        .mintPart(new BN(HEAD2), to, new BN(amount))
        .accounts({
          config: configPda,
          signer: authority.publicKey,
          minter: minterPda(authority.publicKey),
          partConfig: partConfigPda(HEAD2),
          partMint: parts[HEAD2],
          to,
          toAta: ata(to, parts[HEAD2]),
          mintAuth: mintAuthPda,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    async function mintBody(to: PublicKey, amount: number) {
      await program.methods
        .mintPart(new BN(BODY), to, new BN(amount))
        .accounts({
          config: configPda,
          signer: authority.publicKey,
          minter: minterPda(authority.publicKey),
          partConfig: partConfigPda(BODY),
          partMint: parts[BODY],
          to,
          toAta: ata(to, parts[BODY]),
          mintAuth: mintAuthPda,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  });

  // ------------------------------------------------------------------
  // 10. close_identity
  // ------------------------------------------------------------------
  it("close_identity：带装备失败；卸空后成功；名称随之释放（可再铸同名）", async () => {
    const identity = aliceIdentityMint.identity;
    const mint = aliceIdentityMint.mint;

    const closeTx = () =>
      program.methods
        .closeIdentity()
        .accounts({
          identity,
          nameRecord: nameRecordPda("Alice"),
          signer: alice.publicKey,
          identityMint: mint,
          ownerAta: ata(alice.publicKey, mint),
          tokenProgram: TOKEN_PROGRAM,
        })
        .signers([alice])
        .rpc();

    // 插槽 0 还有装备 → 失败
    await expectErr(closeTx(), "SlotsNotEmpty");

    // 卸空
    await program.methods
      .unequip(0)
      .accounts({
        identity,
        signer: alice.publicKey,
        partMint: parts[HEAD2],
        escrowAta: ata(identity, parts[HEAD2]),
        ownerAta: ata(alice.publicKey, parts[HEAD2]),
        tokenProgram: TOKEN_PROGRAM,
      })
      .signers([alice])
      .rpc();

    await closeTx();

    // Identity PDA 已关闭
    assert.isNull(await provider.connection.getAccountInfo(identity));
    // NameRecord 同步关闭（租金退回 owner）——名字释放,不再永久占用
    const nr = await provider.connection.getAccountInfo(nameRecordPda("Alice"));
    assert.isNull(nr);

    // 其他钱包可以铸同名（名字已释放）
    const { identity: bobIdentity } = await mintIdentity(bob, "Alice");
    assert.isNotNull(await provider.connection.getAccountInfo(bobIdentity));
    // 原 owner 换个名字也能再铸
    const { identity: newIdentity } = await mintIdentity(alice, "Alice2");
    assert.isNotNull(await provider.connection.getAccountInfo(newIdentity));
  });

  // ------------------------------------------------------------------
  // 10b. 铸造费率（主网防批量抢注）
  // ------------------------------------------------------------------
  it("set_mint_tier：非 authority/非法档位失败；按铸造数阶梯收费(下一铸 t2、再铸 t3)；缺/错接收账户失败；全零恢复免费", async () => {
    // 当前累计铸造数(config.reserved[0..8] u64le)
    const cfg: any = await program.account.config.fetch(configPda);
    const count = Number(Buffer.from(cfg.reserved as number[]).readBigUInt64LE(0));
    const T2 = new BN(1_000_000); // 0.001 SOL
    const T3 = new BN(2_000_000); // 0.002 SOL

    // 非 authority 设置失败
    await expectErr(
      program.methods
        .setMintTier(new BN(0), T2, T3, new BN(count), new BN(count + 1))
        .accounts({ config: configPda, authority: bob.publicKey })
        .signers([bob])
        .rpc(),
      "Unauthorized"
    );

    // 非法档位(t2_start >= t3_start)失败
    await expectErr(
      program.methods
        .setMintTier(new BN(0), T2, T3, new BN(count + 5), new BN(count + 2))
        .accounts({ config: configPda, authority: authority.publicKey })
        .rpc(),
      "InvalidTier"
    );

    // authority 设阶梯:第 count+1 个起 t2,第 count+2 个起 t3
    await program.methods
      .setMintTier(new BN(0), T2, T3, new BN(count), new BN(count + 1))
      .accounts({ config: configPda, authority: authority.publicKey })
      .rpc();

    // 收费铸造(第 count+1 个):owner 被扣 t2,authority 收到
    const carolBefore = await provider.connection.getBalance(carol.publicKey);
    const authBefore = await provider.connection.getBalance(authority.publicKey);
    await mintIdentity(carol, "Carol", authority.publicKey);
    const carolSpent = carolBefore - (await provider.connection.getBalance(carol.publicKey));
    const authGain = (await provider.connection.getBalance(authority.publicKey)) - authBefore;
    // authority 同时是 feePayer,净收入 = 费率 - 交易费,留 0.0002 SOL 容差
    assert.isAtLeast(carolSpent, T2.toNumber() - 200_000);
    assert.isAtLeast(authGain, T2.toNumber() - 200_000);

    // 第 count+2 个起收 t3:费率>0 但未传 fee_receiver(程序 ID 占位) → 失败
    await expectErr(mintIdentity(dave, "DaveNoFee"), "MintFeeReceiverRequired");

    // 费率>0 时 fee_receiver 传错地址 → 失败
    await expectErr(mintIdentity(dave, "DaveWrongFee", dave.publicKey), "InvalidFeeReceiver");

    // dave 正常付费铸造(应扣 t3)
    const daveBefore = await provider.connection.getBalance(dave.publicKey);
    await mintIdentity(dave, "Dave", authority.publicKey);
    const daveSpent = daveBefore - (await provider.connection.getBalance(dave.publicKey));
    assert.isAtLeast(daveSpent, T3.toNumber() - 200_000);

    // 档位全零,恢复免费铸造
    await program.methods
      .setMintTier(new BN(0), new BN(0), new BN(0), new BN(1), new BN(2))
      .accounts({ config: configPda, authority: authority.publicKey })
      .rpc();
    const eve = await newWallet();
    const { identity: eveId } = await mintIdentity(eve, "EveFree");
    assert.isNotNull(await provider.connection.getAccountInfo(eveId));
  });

  // ------------------------------------------------------------------
  // 11. minter 移除
  // ------------------------------------------------------------------
  it("remove_minter 后原 minter 铸造失败", async () => {
    // 找一个未注册的 part 仅验证权限路径：直接对已注册 part 用 bob 铸
    await program.methods
      .removeMinter()
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        minter: minterPda(bob.publicKey),
      })
      .rpc();
    await expectErr(
      program.methods
        .mintPart(new BN(BODY), bob.publicKey, new BN(1))
        .accounts({
          config: configPda,
          signer: bob.publicKey,
          minter: minterPda(bob.publicKey),
          partConfig: partConfigPda(BODY),
          partMint: parts[BODY],
          to: bob.publicKey,
          toAta: ata(bob.publicKey, parts[BODY]),
          mintAuth: mintAuthPda,
          tokenProgram: TOKEN_PROGRAM,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([bob])
        .rpc(),
      "UnauthorizedMinter"
    );
  });
});
