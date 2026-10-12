import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import pkg from "../package.json";
import { resolveExecutable } from "../shared/executables";

const root = path.resolve(".package-smoke");
fs.mkdirSync(root, { recursive: true });
const npm = resolveExecutable("npm", { nodeExecutable: resolveExecutable("node").command });
const run = (command: string, args: string[], cwd = process.cwd()) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return result.stdout;
};
const packed = JSON.parse(
  run(npm.command, [...npm.args, "pack", "--json", "--ignore-scripts", "--pack-destination", root]),
)[0];
const archive = path.join(root, packed.filename);
const consumer = fs.mkdtempSync(path.join(root, "consumer-"));
fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ private: true }));
run(
  npm.command,
  [
    ...npm.args,
    "install",
    archive,
    "--ignore-scripts",
    "--package-lock=false",
    "--no-audit",
    "--no-fund",
  ],
  consumer,
);
const node = process.env.TEST_NODE_EXECUTABLE ?? resolveExecutable("node").command;
for (const bin of ["claude-connect", "claude-share"]) {
  const entry = path.join(
    root,
    path.relative(root, consumer),
    "node_modules",
    "@0xpv",
    "claude-share",
    "dist",
    bin,
    "index.js",
  );
  if (run(node, [entry, "--version"]).trim() !== pkg.version)
    throw new Error("Installed CLI version smoke check failed");
  if (
    fs.readFileSync(entry, "utf8") !== fs.readFileSync(path.join("dist", bin, "index.js"), "utf8")
  )
    throw new Error("Installed package differs from the fresh build");
}
for (const bin of ["claude-share", "claude-connect"]) {
  const contents = fs.readFileSync(path.join("dist", bin, "index.js"), "utf8");
  if (contents.includes("CLAUDE_SHARE_BUILD_SECRET_SENTINEL"))
    throw new Error("Build embedded a secret");
}
process.stdout.write("Package installation and both CLI entrypoints passed.\n");
