import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";

import * as p from "@clack/prompts";
import {
  resolveExecutable,
  spawnExecutable,
  terminateChild,
  type Executable,
} from "@shared/executables";
import { platform } from "@shared/platforms";
import { atomicPrivateWrite, ensurePrivateDir, privateTempDir } from "@shared/private-files";
import { uuid, validateCa, serverUrl } from "@shared/validation";

import { apiFetch } from "./fetch";
import { logger } from "./logger";
import type { SharerAccount } from "./types";

const PLACEHOLDER_CREDENTIALS = {
  claudeAiOauth: {
    accessToken: "claude-share-placeholder",
    refreshToken: "",
    expiresAt: 4102444800000,
    scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
    subscriptionType: "pro",
    rateLimitTier: "default_claude_ai",
  },
};
export async function prepareProfile(configDir: string) {
  ensurePrivateDir(configDir);
  const configPath = path.join(configDir, ".claude.json");
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  atomicPrivateWrite(
    configPath,
    JSON.stringify({ ...config, hasCompletedOnboarding: true }, null, 2),
  );
  await platform().writeOAuthCredentials(PLACEHOLDER_CREDENTIALS, configDir);
}
export async function checkClaudeInstalled() {
  try {
    resolveExecutable("claude");
    return true;
  } catch {
    return false;
  }
}
export function receiverEnvironment(
  parent: NodeJS.ProcessEnv,
  proxy: string,
  cert: string,
  profile: string,
): NodeJS.ProcessEnv {
  const env = { ...parent };
  const remove = new Set([
    "NO_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "GLOBAL_AGENT_HTTP_PROXY",
    "GLOBAL_AGENT_HTTPS_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "CURL_CA_BUNDLE",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_OPTIONS",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_API_KEY_HELPER",
    "CLAUDE_CODE_SKIP_AUTH",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ]);
  for (const key of Object.keys(env))
    if (remove.has(key.toUpperCase()) || key.toUpperCase().startsWith("ANTHROPIC_"))
      delete env[key];
  return {
    ...env,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    NO_PROXY: "",
    NODE_EXTRA_CA_CERTS: cert,
    SSL_CERT_FILE: cert,
    CURL_CA_BUNDLE: cert,
    CLAUDE_CONFIG_DIR: profile,
    // Environment OAuth takes precedence over macOS Keychain and cannot expose the receiver's real credentials.
    CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_CREDENTIALS.claudeAiOauth.accessToken,
  };
}
export async function sessionPost(
  server: string,
  endpoint: string,
  body: Record<string, string>,
  caPem?: string,
  proxyAuth?: string,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (proxyAuth) headers["Proxy-Authorization"] = proxyAuth;
  const response = await apiFetch(server + endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeout: 5000,
    ca: caPem,
  });
  return response.ok ? ((await response.json()) as Record<string, unknown>) : {};
}
export async function launchClaude(
  proxyUrl: string,
  caPem: string,
  meta: { systemName: string; id: string; proxyUser: string; proxyPass: string },
  claudeArgs: string[] = [],
  sharerAccount: SharerAccount | null = null,
  options: { executable?: Executable; profileRoot?: string; quiet?: boolean } = {},
): Promise<number> {
  const executable = options.executable ?? resolveExecutable("claude");
  proxyUrl = serverUrl(proxyUrl);
  validateCa(caPem);
  const id = uuid(meta.id);
  if (id !== meta.proxyUser) throw new Error("Connection identity mismatch");
  const profile = path.join(
    options.profileRoot ?? path.join(os.homedir(), ".claude-share", "profiles"),
    id,
  );
  await prepareProfile(profile);
  const certDir = privateTempDir("claude-share-ca-");
  const certPath = path.join(certDir, "ca.pem");
  const auth = "Basic " + Buffer.from(meta.proxyUser + ":" + meta.proxyPass).toString("base64");
  let sessionId: string | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let child: ReturnType<typeof spawnExecutable> | undefined;
  let interrupt: NodeJS.Signals | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let cleaning = false;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (interrupt || cleaning) return;
    interrupt = signal;
    if (child) terminateChild(child, signal);
    killTimer = setTimeout(() => {
      if (child) terminateChild(child, "SIGKILL");
    }, 5000);
    killTimer.unref();
  };
  const onInt = () => handleSignal("SIGINT");
  const onTerm = () => handleSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    atomicPrivateWrite(certPath, [caPem, ...rootCertificates].join("\n"));
    try {
      const response = await sessionPost(
        proxyUrl,
        "/session/start",
        { machineId: id },
        caPem,
        auth,
      );
      if (typeof response.sessionId !== "string")
        throw new Error("Sharer rejected session registration; pair again");
      sessionId = uuid(response.sessionId);
    } catch (err) {
      logger.error("session/start failed", err);
      throw err;
    }
    if (interrupt) {
      const result = interrupt === "SIGINT" ? 130 : 143;
      process.exitCode = result;
      return result;
    }
    heartbeat = setInterval(() => {
      void sessionPost(
        proxyUrl,
        "/session/heartbeat",
        { machineId: id, sessionId: sessionId! },
        caPem,
        auth,
      ).catch(() => {});
    }, 30_000);
    heartbeat.unref();
    if (!options.quiet) {
      if (sharerAccount)
        p.log.info(
          "Account: " + sharerAccount.displayName + " (" + sharerAccount.emailAddress + ")",
        );
      p.log.success("Launching Claude...");
      p.outro("");
    }
    const parsed = new URL(proxyUrl);
    parsed.username = meta.proxyUser;
    parsed.password = meta.proxyPass;
    const env = receiverEnvironment(process.env, parsed.toString(), certPath, profile);
    child = spawnExecutable(executable, claudeArgs, {
      stdio: options.quiet ? "ignore" : "inherit",
      env,
    });
    const result = await new Promise<number>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", (code, signal) =>
        resolve(
          interrupt === "SIGINT" || signal === "SIGINT"
            ? 130
            : interrupt === "SIGTERM" || signal === "SIGTERM"
              ? 143
              : (code ?? 1),
        ),
      );
    });
    process.exitCode = result;
    return result;
  } finally {
    cleaning = true;
    if (heartbeat) clearInterval(heartbeat);
    clearTimeout(killTimer);
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    if (sessionId)
      await sessionPost(proxyUrl, "/session/end", { machineId: id, sessionId }, caPem, auth).catch(
        () => {},
      );
    fs.rmSync(certDir, { recursive: true, force: true });
  }
}
