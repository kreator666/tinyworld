import { Connection, PublicKey } from '@solana/web3.js'
import { LBCLMM } from '@meteora-ag/dlmm-sdk'

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const WSOL = new PublicKey('So11111111111111111111111111111111111111112')
const DLMM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo')

async function main() {
  const conn = new Connection('https://mainnet.helius-rpc.com/?api-key=7a428c62-716d-446a-85c2-5c046fd5fba7', 'confirmed')
  const accs = await conn.getProgramAccounts(DLMM, { filters: [
    { dataSize: 904 },
    { memcmp: { offset: 88, bytes: USDC.toBase58() } },
    { memcmp: { offset: 120, bytes: WSOL.toBase58() } },
  ]})
  console.log('candidates:', accs.length)
  const pairs = await LBCLMM.createMultiple(conn, accs.map(a => a.pubkey), { cluster: 'mainnet-beta' })
  const rows = pairs.map(p => {
    const anyP = p as any
    const usdc = Number(anyP.tokenX?.reserveTokenAmount ?? anyP.tokenX?.amount ?? 0n)
    const wsol = Number(anyP.tokenY?.reserveTokenAmount ?? anyP.tokenY?.amount ?? 0n)
    return {
      pair: anyP.pubkey?.toBase58?.() ?? String(anyP.pubkey),
      binStep: anyP.lbPair?.binStep ?? anyP.binStep,
      activeId: anyP.lbPair?.activeId ?? anyP.activeId,
      usdc: usdc / 1e6, wsol: wsol / 1e9,
    }
  }).sort((a, b) => b.usdc - a.usdc)
  rows.slice(0, 10).forEach(r => console.log(r.pair, 'binStep', r.binStep, 'activeId', r.activeId, 'USDC', r.usdc.toFixed(0), 'WSOL', r.wsol.toFixed(1)))
}
main().catch(e => { console.error(e.message); process.exit(1) })
