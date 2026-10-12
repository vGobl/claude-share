import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { atomicPrivateWrite, ensurePrivateDir, protectPath } from "@shared/private-files";
import { record, uuid, isoDate, validateConnection } from "@shared/validation";

import type { ReceiverConfig, SavedConnection } from "./types";

export const CLAUDE_SHARE_DIR = path.join(os.homedir(), ".claude-share");
export const CONNECTIONS_DIR = path.join(CLAUDE_SHARE_DIR, "connections");
const CONFIG_FILE = path.join(CLAUDE_SHARE_DIR, "config.json");
export function ensureConnectionsDir() {
  ensurePrivateDir(CLAUDE_SHARE_DIR);
  ensurePrivateDir(CONNECTIONS_DIR);
}
export function connectionPath(id: string) {
  return path.join(CONNECTIONS_DIR, uuid(id) + ".json");
}
function readConfig(): ReceiverConfig | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return null;
  }
}
function writeConfig(config: ReceiverConfig) {
  atomicPrivateWrite(CONFIG_FILE, JSON.stringify({ ...readConfig(), ...config }, null, 2));
}
export function getDeviceName(): string {
  const saved = readConfig();
  if (saved?.deviceName) return saved.deviceName;
  const name = os.hostname();
  writeConfig({ deviceName: name });
  return name;
}
export function hasAgreedToTerms() {
  return readConfig()?.hasConnectTermsAgreed === true;
}
export function saveTermsAgreed() {
  writeConfig({ ...(readConfig() ?? { deviceName: os.hostname() }), hasConnectTermsAgreed: true });
}
export function loadConnections(): SavedConnection[] {
  ensureConnectionsDir();
  const connections: SavedConnection[] = [];
  for (const filename of fs.readdirSync(CONNECTIONS_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const file = path.join(CONNECTIONS_DIR, filename);
      if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 256 * 1024)
        throw new Error("Invalid connection file");
      protectPath(file);
      const raw = record(JSON.parse(fs.readFileSync(file, "utf8")));
      const connection = validateConnection(raw);
      const id = uuid(raw.id);
      if (id !== connection.proxyUser || filename !== id + ".json")
        throw new Error("Connection identity mismatch");
      connections.push({ ...connection, id, savedAt: isoDate(raw.savedAt) });
    } catch (err) {
      process.stderr.write(
        "Ignoring invalid saved connection " +
          filename +
          ": " +
          (err as Error).message +
          ". Remove it and pair again.\n",
      );
    }
  }
  return connections;
}
export function pruneExpiredConnections() {
  ensureConnectionsDir();
  for (const filename of fs.readdirSync(CONNECTIONS_DIR).filter((f) => f.endsWith(".json"))) {
    const file = path.join(CONNECTIONS_DIR, filename);
    try {
      if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 256 * 1024) continue;
      const raw = record(JSON.parse(fs.readFileSync(file, "utf8")));
      if (typeof raw.sharedUntil === "string" && Date.parse(raw.sharedUntil) <= Date.now())
        fs.unlinkSync(file);
    } catch {
      /* loadConnections reports invalid entries with recovery instructions. */
    }
  }
}
export function findConnectionByServerUrl(serverUrl: string): SavedConnection | null {
  return (
    loadConnections()
      .filter((c) => c.lanServerUrl === serverUrl || c.publicServerUrl === serverUrl)
      .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))[0] ?? null
  );
}
