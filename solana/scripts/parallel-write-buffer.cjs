// 并行分块写 buffer(绕开 solana CLI 的串行 write-buffer)
// LoaderInstruction::Write{offset,bytes}: bincode = [tag u32=1][offset u32][bytes vec(u64 len + data)]
// 账户: [buffer(mut), authority(signer)]。1KB/ix,12 路并发。
const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction } = require('@solana/web3.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RPC = process.env.RPC ?? 'https://solana-testnet-rpc.publicnode.com';
const BUFFER = new PublicKey('8aazZTRJfRarAvugyfxWCDFgfuCRptKKy8WPTUz6QGVQ');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const CHUNK = 1000;
const CONCURRENCY = 12;

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'solana', 'id.json'), 'utf8')))
  );
  const binary = fs.readFileSync('D:/agent/tinyworld/solana/target/deploy/tinyworld.so');

  // 只写缺失/不一致的 chunk
  const bufInfo = await conn.getAccountInfo(BUFFER);
  const onchain = bufInfo ? bufInfo.data : Buffer.alloc(0);
  const chunks = [];
  for (let off = 0; off < binary.length; off += CHUNK) {
    const piece = binary.subarray(off, Math.min(off + CHUNK, binary.length));
    const header = 37; // BufferState header: 4 tag + 1 option + 32 authority
    const start = header + off;
    const existing = onchain.subarray(start, start + piece.length);
    if (existing.length === piece.length && existing.equals(piece)) continue;
    chunks.push({ off, piece });
  }
  console.log(`需写入 chunk: ${chunks.length}/${Math.ceil(binary.length / CHUNK)}`);

  let done = 0;
  let failed = 0;
  const writeChunk = async ({ off, piece }) => {
    const data = Buffer.alloc(4 + 4 + 8 + piece.length);
    data.writeUInt32LE(1, 0); // Write
    data.writeUInt32LE(off, 4);
    data.writeBigUInt64LE(BigInt(piece.length), 8);
    piece.copy(data, 16);
    const tx = new Transaction().add(
      new TransactionInstruction({
        programId: LOADER,
        keys: [
          { pubkey: BUFFER, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        ],
        data,
      })
    );
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(wallet);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        await conn.confirmTransaction(sig, 'confirmed');
        done++;
        if (done % 50 === 0) console.log(`进度 ${done}/${chunks.length}`);
        return;
      } catch (e) {
        if (attempt === 2) {
          failed++;
          console.error(`chunk@${off} 失败:`, String(e).slice(0, 80));
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };

  const queue = [...chunks];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const c = queue.shift();
      if (c) await writeChunk(c);
    }
  });
  await Promise.all(workers);
  console.log(`写入完成: ${done} 成功, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
