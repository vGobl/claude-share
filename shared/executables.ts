import { execFile, spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface Executable {
  command: string;
  args: string[];
}
export function resolveExecutable(
  name: string,
  options: { platform?: NodeJS.Platform; searchPath?: string; nodeExecutable?: string } = {},
): Executable {
  const windows = (options.platform ?? process.platform) === "win32";
  const directories = (options.searchPath ?? process.env.PATH ?? "")
    .split(windows ? ";" : ":")
    .filter(Boolean);
  for (const directory of directories) {
    const native = path.join(directory, windows ? `${name}.exe` : name);
    try {
      if (fs.statSync(native).isFile()) {
        fs.accessSync(native, windows ? fs.constants.F_OK : fs.constants.X_OK);
        return { command: native, args: [] };
      }
    } catch {}
    if (!windows || !fs.existsSync(path.join(directory, `${name}.cmd`))) continue;
    const packageName = name === "claude" ? "@anthropic-ai/claude-code" : name;
    for (const root of [path.join(directory, "node_modules"), path.dirname(directory)]) {
      const packageDir = path.join(root, packageName);
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[name];
        if (typeof bin !== "string") continue;
        const entry = path.resolve(packageDir, bin);
        if (
          !entry.startsWith(path.resolve(packageDir) + path.sep) ||
          !/\.[cm]?js$/.test(entry) ||
          !fs.statSync(entry).isFile()
        )
          continue;
        return { command: options.nodeExecutable ?? process.execPath, args: [entry] };
      } catch {}
    }
  }
  throw new Error(
    `${name} was not found in PATH as a native executable or supported npm JavaScript entrypoint`,
  );
}

export function spawnExecutable(
  executable: Executable,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(executable.command, [...executable.args, ...args], {
    ...options,
    shell: false,
    windowsHide: true,
  });
}

export function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    // Terminate only this launched child's tree, including native CLI helpers.
    execFile(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true },
      (err) => {
        if (err && child.exitCode === null && child.signalCode === null) child.kill(signal);
      },
    );
  } else child.kill(signal);
}
