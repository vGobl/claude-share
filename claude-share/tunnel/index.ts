import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as p from "@clack/prompts";
import { resolveExecutable, spawnExecutable, type Executable } from "@shared/executables";
import { privateTempDir } from "@shared/private-files";

import { normalizeHostname } from "../proxy/policy";

const execFileAsync = promisify(execFile);
const BORE_LOCAL_PATH = path.join(os.homedir(), ".local", "bin", "bore");
export interface Tunnel {
  publicUrl: string | null;
  close(): void;
}
async function getBorePath(): Promise<string | null> {
  try {
    return resolveExecutable("bore").command;
  } catch {}
  try {
    await fs.promises.access(BORE_LOCAL_PATH, fs.constants.X_OK);
    return BORE_LOCAL_PATH;
  } catch {
    return null;
  }
}
export async function isBoreInstalled() {
  return (await getBorePath()) !== null;
}
const DOWNLOAD_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
export async function boundedDownload(
  url: string,
  maxBytes: number,
  fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const target = new URL(url);
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        !DOWNLOAD_HOSTS.has(target.hostname)
      )
        throw new Error("Untrusted bore download URL");
      const response = await fetcher(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "claude-share" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("Invalid download redirect");
        url = new URL(location, target).href;
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("Download failed: HTTP " + response.status);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maxBytes) throw new Error("Download too large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return Buffer.concat(chunks);
    }
    throw new Error("Too many download redirects");
  } finally {
    clearTimeout(timer);
  }
}
const ARCH_MAP: Record<string, string> = {
  x64: "x86_64-unknown-linux-musl",
  arm64: "aarch64-unknown-linux-musl",
  arm: "armv7-unknown-linux-musleabihf",
  ia32: "i686-unknown-linux-musl",
};
export async function installBore() {
  if (process.platform !== "linux")
    throw new Error(
      "Automatic bore installation is supported on the Linux sharer only; install bore manually.",
    );
  const triple = ARCH_MAP[process.arch];
  if (!triple) throw new Error("No bore binary for this architecture; install bore manually.");
  const spin = p.spinner();
  spin.start("Downloading bore from GitHub...");
  const dir = privateTempDir("bore-install-");
  try {
    const release = JSON.parse(
      (
        await boundedDownload(
          "https://api.github.com/repos/ekzhang/bore/releases/latest",
          1024 * 1024,
        )
      ).toString("utf8"),
    );
    const tag = release.tag_name;
    if (typeof tag !== "string" || !/^v?\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(tag))
      throw new Error("Invalid bore release");
    const filename = "bore-" + tag + "-" + triple + ".tar.gz";
    const archive = await boundedDownload(
      "https://github.com/ekzhang/bore/releases/download/" + tag + "/" + filename,
      32 * 1024 * 1024,
    );
    const digest = release.assets?.find((a: { name: string }) => a.name === filename)?.digest;
    if (
      digest &&
      (typeof digest !== "string" ||
        digest !== "sha256:" + createHash("sha256").update(archive).digest("hex"))
    )
      throw new Error("Bore checksum mismatch");
    const archivePath = path.join(dir, filename);
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    await execFileAsync("tar", ["xzf", archivePath, "-C", dir, "bore"], { timeout: 30_000 });
    if (!fs.lstatSync(path.join(dir, "bore")).isFile()) throw new Error("Invalid bore archive");
    fs.mkdirSync(path.dirname(BORE_LOCAL_PATH), { recursive: true });
    const staging = BORE_LOCAL_PATH + ".install-" + path.basename(dir);
    try {
      fs.copyFileSync(path.join(dir, "bore"), staging, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(staging, 0o755);
      fs.renameSync(staging, BORE_LOCAL_PATH);
    } finally {
      if (fs.existsSync(staging)) fs.unlinkSync(staging);
    }
    spin.stop("Bore installed.");
  } catch (err) {
    spin.stop("Installation failed; install bore manually.");
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
export async function startTunnel(
  localPort: number,
  onDown?: () => void,
  executable?: Executable,
): Promise<Tunnel> {
  const server = normalizeHostname(process.env.BORE_SERVER ?? "bore.pub");
  const password = process.env.BORE_PASSWORD ?? "";
  const binary = executable?.command ?? (await getBorePath());
  if (!binary) throw new Error("Bore is not installed");
  const args = ["local", String(localPort), "--to", server];
  if (password) args.push("--secret", password);
  return new Promise((resolve, reject) => {
    const proc = spawnExecutable(executable ?? { command: binary, args: [] }, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let closing = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      closing = true;
      proc.kill();
      reject(new Error("Bore timed out"));
    }, 30_000);
    // Keep stdout/stderr framing separate, and retain partial lines.
    const tails = { stdout: "", stderr: "" };
    const data = (stream: keyof typeof tails, chunk: Buffer) => {
      tails[stream] = (tails[stream] + chunk.toString()).slice(-16 * 1024);
      const match = tails[stream].match(/listening at \S+:(\d+)(?:\r?\n)/i);
      const port = match ? Number(match[1]) : 0;
      if (!settled && Number.isInteger(port) && port > 0 && port <= 65535) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          publicUrl: "https://" + server + ":" + port,
          close() {
            closing = true;
            proc.kill();
          },
        });
      }
    };
    proc.stdout!.on("data", (chunk) => data("stdout", chunk));
    proc.stderr!.on("data", (chunk) => data("stderr", chunk));
    proc.once("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(new Error("Bore exited with code " + code));
      } else if (!closing) onDown?.();
    });
  });
}
