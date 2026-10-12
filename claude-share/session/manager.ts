import crypto from "node:crypto";
import { webcrypto } from "node:crypto";

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { toBase58 } from "@shared/base58";
import { isUnlimitedSharing, UNLIMITED_SHARED_UNTIL } from "@shared/sharing-expiry";
import type { ConnectionFile, SharerAccount } from "@shared/types";

function randomBytes(n: number): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(n));
}

export type SessionStatus = "waiting" | "active" | "expired" | "revoked";

export interface MachineSession {
  id: string;
  startedAt: Date;
  lastActiveAt: Date;
  active: boolean;
}

export interface Machine {
  id: string;
  name: string;
  pairedAt: Date;
  sessions: Map<string, MachineSession>;
  proxyPass: string;
}

export type { ConnectionFile, SharerAccount } from "@shared/types";

export interface Session {
  id: string;
  /** Current pairing key — replaced each time a new pairing code is generated */
  key: Uint8Array;
  pairingCode: string;
  /** True after a machine successfully pairs with this code */
  pairingCodeUsed: boolean;
  sharedUntil: Date;
  machines: Map<string, Machine>;
  status: SessionStatus;
  createdAt: Date;
}

let currentSession: Session | null = null;

export function createSession(durationMs: number): Session {
  const key = randomBytes(32);
  currentSession = {
    id: crypto.randomUUID(),
    key,
    pairingCode: toBase58(key),
    pairingCodeUsed: false,
    sharedUntil: new Date(
      durationMs === Infinity ? UNLIMITED_SHARED_UNTIL : Date.now() + durationMs,
    ),
    machines: new Map(),
    status: "waiting",
    createdAt: new Date(),
  };
  return currentSession;
}

export function getSession(): Session | null {
  return currentSession;
}

/** Generates a fresh pairing code + key, allowing one more machine to pair. */
export function regeneratePairingCode(session: Session): void {
  const newKey = randomBytes(32);
  session.key.fill(0);
  session.key = newKey;
  session.pairingCode = toBase58(newKey);
  session.pairingCodeUsed = false;
}

/** Encrypts a ConnectionFile for delivery to receiver. Returns hex-encoded blob. */
export function encryptConnectionFile(session: Session, file: ConnectionFile): string {
  const plaintext = new TextEncoder().encode(JSON.stringify(file));
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(session.key, nonce);
  const ciphertext = cipher.encrypt(plaintext);
  return Buffer.from(nonce).toString("hex") + Buffer.from(ciphertext).toString("hex");
}

/** Constant-time pairing code check. Returns false if already used or brute-forced. */
const failedPairings: number[] = [];
export function pairingLimited(now = Date.now()): boolean {
  while (failedPairings.length && failedPairings[0] <= now - 60_000) failedPairings.shift();
  return failedPairings.length >= 20;
}
export function recordPairingFailure(now = Date.now()): void {
  if (!pairingLimited(now)) failedPairings.push(now);
}
export function checkPairingCode(session: Session, code: string): boolean {
  if (pairingLimited()) return false;
  const expected = Buffer.from(session.pairingCode.slice(0, 5), "utf8");
  const provided = Buffer.from(code, "utf8");
  const match =
    !session.pairingCodeUsed &&
    !isSessionExpired(session) &&
    /^[1-9A-HJ-NP-Za-km-z]{5}$/.test(code) &&
    provided.length === expected.length &&
    crypto.timingSafeEqual(expected, provided);
  if (!match) recordPairingFailure();
  return match;
}

function deduplicateName(session: Session, baseName: string): string {
  const names = new Set([...session.machines.values()].map((m) => m.name));
  if (!names.has(baseName)) return baseName;
  let i = 2;
  while (names.has(`${baseName} (${i})`)) i++;
  return `${baseName} (${i})`;
}

/** Creates a Machine entry and burns the current pairing code (one-time use). */
export function addMachine(session: Session, name: string): Machine {
  const machine: Machine = {
    id: crypto.randomUUID(),
    name: deduplicateName(session, name),
    pairedAt: new Date(),
    sessions: new Map(),
    proxyPass: Buffer.from(randomBytes(16)).toString("hex"),
  };
  session.machines.set(machine.id, machine);
  session.pairingCodeUsed = true;
  session.status = "active";
  return machine;
}

/** Returns true if the Proxy-Authorization header matches any active machine. */
export function authenticateMachine(session: Session, authHeader: string): Machine | null {
  if (isSessionExpired(session) || session.status === "revoked") return null;
  const actual = Buffer.from(authHeader);
  for (const machine of session.machines.values()) {
    const expected = Buffer.from(
      "Basic " + Buffer.from(`${machine.id}:${machine.proxyPass}`).toString("base64"),
    );
    if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected))
      return machine;
  }
  return null;
}
export function checkMachineAuth(session: Session, authHeader: string): boolean {
  return authenticateMachine(session, authHeader) !== null;
}

export function addMachineSession(session: Session, machineId: string): MachineSession | null {
  const machine = session.machines.get(machineId);
  if (!machine) return null;
  const ms: MachineSession = {
    id: crypto.randomUUID(),
    startedAt: new Date(),
    lastActiveAt: new Date(),
    active: true,
  };
  machine.sessions.set(ms.id, ms);
  return ms;
}

export function endMachineSession(session: Session, machineId: string, sessionId: string): boolean {
  const ms = session.machines.get(machineId)?.sessions.get(sessionId);
  if (!ms) return false;
  ms.active = false;
  ms.lastActiveAt = new Date();
  return true;
}

export function heartbeatMachineSession(
  session: Session,
  machineId: string,
  sessionId: string,
): boolean {
  const ms = session.machines.get(machineId)?.sessions.get(sessionId);
  if (!ms?.active) return false;
  ms.lastActiveAt = new Date();
  return true;
}

export function isSessionExpired(session: Session): boolean {
  return !isUnlimitedSharing(session.sharedUntil) && Date.now() >= session.sharedUntil.getTime();
}

export function scheduleSessionExpiry(session: Session, onExpire: () => void): () => void {
  if (isUnlimitedSharing(session.sharedUntil)) return () => {};
  const timer = setTimeout(onExpire, Math.max(0, session.sharedUntil.getTime() - Date.now()));
  timer.unref();
  return () => clearTimeout(timer);
}

export function destroySession(): void {
  if (currentSession) {
    currentSession.key.fill(0);
    currentSession = null;
  }
}
