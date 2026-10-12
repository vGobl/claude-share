#!/usr/bin/env bun
import pkg from "../package.json";

// Dependencies stay external so package assets (including Yoga WASM) keep their original paths.
for (const name of ["claude-share", "claude-connect"]) {
  const result = await Bun.build({
    entrypoints: [name + "/index.ts"],
    outdir: "dist/" + name,
    target: "node",
    format: "esm",
    external: Object.keys(pkg.dependencies),
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    env: "disable",
  });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(String(log) + "\n");
    process.exit(1);
  }
}
