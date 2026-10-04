// ============================================================
// 极简 base58 编解码(Solana 地址/签名走 base58;不引第三方包)
// 字母表与 Bitcoin/Solana 一致,前导 0x00 字节编码为 '1'
// ============================================================

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE = 58n
const ALPHABET_MAP = new Map([...ALPHABET].map((ch, i) => [ch, BigInt(i)]))

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  let num = 0n
  for (const b of bytes) num = (num << 8n) | BigInt(b)
  let out = ''
  while (num > 0n) {
    out = ALPHABET[Number(num % BASE)] + out
    num /= BASE
  }
  return '1'.repeat(zeros) + out
}

export function base58Decode(text: string): Uint8Array {
  let num = 0n
  for (const ch of text) {
    const v = ALPHABET_MAP.get(ch)
    if (v === undefined) throw new Error(`非法 base58 字符: ${ch}`)
    num = num * BASE + v
  }
  const bytes: number[] = []
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn))
    num >>= 8n
  }
  let zeros = 0
  while (zeros < text.length && text[zeros] === '1') zeros++
  return new Uint8Array([...new Array<number>(zeros).fill(0), ...bytes])
}
