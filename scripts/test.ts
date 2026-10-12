import fs from "node:fs";
import path from "node:path";

import pkg from "../package.json";
import { resolveExecutable } from "../shared/executables";

const entries = [...new Bun.Glob("tests/*.test.ts").scanSync(".")];
fs.mkdirSync("tests/.build", { recursive: true });
const result = await Bun.build({
  entrypoints: entries,
  outdir: "tests/.build",
  target: "node",
  format: "esm",
  external: Object.keys(pkg.dependencies),
});
if (!result.success) throw new AggregateError(result.logs, "Test compilation failed");
const node = process.env.TEST_NODE_EXECUTABLE ?? resolveExecutable("node").command;
const tests = result.outputs.filter((o) => o.path.endsWith(".js")).map((o) => path.resolve(o.path));
const runner = Bun.spawn([node, "--test", "--test-concurrency=1", ...tests], {
  stdio: ["inherit", "inherit", "inherit"],
});
process.exitCode = await runner.exited;
