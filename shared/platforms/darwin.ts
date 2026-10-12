import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import fileStore from "./file-store";
import type { CredentialPayload, OAuthCredentials, PlatformOps } from "./types";

const execFileAsync = promisify(execFile);
const SERVICE = "Claude Code-credentials";

function username() {
  return os.userInfo().username;
}

const darwin: PlatformOps = {
  async readOAuthCredentials(configDir?: string): Promise<OAuthCredentials> {
    if (configDir) return fileStore.readOAuthCredentials(configDir);
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      username(),
      "-w",
    ]);
    const payload: CredentialPayload = JSON.parse(stdout.trim());
    return payload.claudeAiOauth;
  },

  async credentialsExist(configDir?: string): Promise<boolean> {
    if (configDir) return fileStore.credentialsExist(configDir);
    return execFileAsync("security", ["find-generic-password", "-s", SERVICE, "-a", username()])
      .then(() => true)
      .catch(() => false);
  },

  async writeOAuthCredentials(payload: CredentialPayload, configDir?: string): Promise<void> {
    if (configDir) return fileStore.writeOAuthCredentials(payload, configDir);
    await execFileAsync("security", [
      "add-generic-password",
      "-s",
      SERVICE,
      "-a",
      username(),
      "-w",
      JSON.stringify(payload),
      "-U",
    ]);
  },

  async getSystemName(): Promise<string> {
    try {
      const { stdout } = await execFileAsync("scutil", ["--get", "ComputerName"]);
      return stdout.trim();
    } catch {
      return os.hostname();
    }
  },
};

export default darwin;
