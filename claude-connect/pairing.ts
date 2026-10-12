import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { fromBase58 } from "@shared/base58";
import { serverUrl, validateConnection } from "@shared/validation";

import type { ConnectionFile } from "./types";

export function decryptBlob(blob: string, pairingCode: string): ConnectionFile {
  // Pairing code is the full 32-byte session key encoded in base58
  const key = decodePairingKey(pairingCode);
  if (
    typeof blob !== "string" ||
    blob.length < 80 ||
    blob.length > 256 * 1024 ||
    blob.length % 2 ||
    !/^[0-9a-f]+$/i.test(blob)
  )
    throw new Error("Invalid encrypted connection");

  const nonceHex = blob.slice(0, 48);
  const ctHex = blob.slice(48);
  const nonce = Uint8Array.from(Buffer.from(nonceHex, "hex"));
  const ciphertext = Uint8Array.from(Buffer.from(ctHex, "hex"));

  const cipher = xchacha20poly1305(key, nonce);
  try {
    const plaintext = cipher.decrypt(ciphertext);
    return validateConnection(JSON.parse(new TextDecoder().decode(plaintext)));
  } finally {
    key.fill(0);
  }
}

export function decodePairingKey(code: string): Uint8Array {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(code)) throw new Error("Invalid pairing key");
  const key = fromBase58(code);
  if (key.length !== 32) throw new Error("Pairing key must contain exactly 32 bytes");
  return key;
}

// Format: claudeshare://host:port/connect/<pairingCode>  (or https:// for backwards compat)
// The server does not need to handle this path — it's parsed client-side only.
export function parseConnectUrl(url: string): { serverUrl: string; pairingCode: string } | null {
  if (!/^(claudeshare|https):\/\//.test(url)) return null;
  const normalised = url.replace(/^claudeshare:\/\//, "https://");
  const match = normalised.match(/^(https:\/\/.+?)\/connect\/([A-Za-z0-9]+)$/);
  if (!match || url.length > 2200) return null;
  try {
    decodePairingKey(match[2]);
    return { serverUrl: serverUrl(match[1]), pairingCode: match[2] };
  } catch {
    return null;
  }
}
