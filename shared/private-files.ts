import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function protectPath(target: string, directory = false): void {
  if (process.platform === "win32") {
    const identity = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const sid = identity.match(/S-1-5-[0-9-]+/)?.[0];
    if (!sid) throw new Error("Could not determine Windows user SID");
    execFileSync("icacls.exe", [target, "/reset"], { stdio: "pipe", windowsHide: true });
    execFileSync(
      "icacls.exe",
      [target, "/inheritance:r", "/grant:r", `*${sid}:${directory ? "(OI)(CI)" : ""}F`],
      { stdio: "pipe", windowsHide: true },
    );
  } else fs.chmodSync(target, directory ? 0o700 : 0o600);
}

export function ensurePrivateDir(target: string): void {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  protectPath(target, true);
}

export function atomicPrivateWrite(target: string, contents: string): void {
  ensurePrivateDir(path.dirname(target));
  const temporary = path.join(path.dirname(target), `.write-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    protectPath(temporary);
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function privateTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    protectPath(dir, true);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return dir;
}
