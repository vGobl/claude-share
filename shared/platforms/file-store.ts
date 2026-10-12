import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { atomicPrivateWrite } from "../private-files";
import type { PlatformOps, CredentialPayload, OAuthCredentials } from "./types";

export const credentialPath = (configDir?: string) =>
  path.join(
    configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    ".credentials.json",
  );
export function validateOAuth(value: unknown): OAuthCredentials {
  const creds = (value as CredentialPayload)?.claudeAiOauth;
  if (
    !creds ||
    typeof creds.accessToken !== "string" ||
    !creds.accessToken ||
    !Number.isFinite(creds.expiresAt)
  )
    throw new Error("Invalid Claude OAuth credentials; run Claude /login on the sharer");
  return creds;
}
const fileStore: PlatformOps = {
  async readOAuthCredentials(configDir) {
    return validateOAuth(JSON.parse(await fs.promises.readFile(credentialPath(configDir), "utf8")));
  },
  async credentialsExist(configDir) {
    return fs.existsSync(credentialPath(configDir));
  },
  async writeOAuthCredentials(payload, configDir) {
    atomicPrivateWrite(credentialPath(configDir), JSON.stringify(payload, null, 2));
  },
  async getSystemName() {
    return os.hostname();
  },
};
export default fileStore;
