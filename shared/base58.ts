const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function toBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let num = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  const result: string[] = [];
  while (num > 0n) {
    result.push(ALPHABET[Number(num % 58n)]);
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    result.push(ALPHABET[0]);
  }
  return result.reverse().join("");
}

export function fromBase58(str: string): Uint8Array {
  let num = 0n;
  for (const char of str) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }
  const leadingZeros = str.match(/^1*/)?.[0].length ?? 0;
  let hex = num === 0n ? "" : num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Uint8Array.from(Buffer.concat([Buffer.alloc(leadingZeros), Buffer.from(hex, "hex")]));
}
