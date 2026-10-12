import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { apiFetch } from "../claude-connect/fetch";
import { launchClaude, receiverEnvironment } from "../claude-connect/launch";
import { decryptBlob } from "../claude-connect/pairing";
import { initToken, getAccessToken, stopTokenRefresh } from "../claude-share/proxy/token";
import { createApiApp } from "../claude-share/server";
import { createSession, getSession, destroySession } from "../claude-share/session/manager";
import { resolveExecutable, spawnExecutable } from "../shared/executables";
import { atomicPrivateWrite, privateTempDir } from "../shared/private-files";
import { certificates } from "./certificates";

test("atomic secret files have private permissions and replace contents safely", () => {
  const root = privateTempDir("claude-share-test-permissions-");
  const target = path.join(root, "secret.json");
  try {
    atomicPrivateWrite(target, "first");
    atomicPrivateWrite(target, "second");
    assert.equal(fs.readFileSync(target, "utf8"), "second");
    assert.deepEqual(fs.readdirSync(root), ["secret.json"]);
    if (process.platform === "win32") {
      const acl = JSON.parse(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "ConvertTo-Json -InputObject @((Get-Acl -LiteralPath $env:CLAUDE_SHARE_TEST_ACL_PATH).Access | ForEach-Object { @{ Sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; Inherited = $_.IsInherited; Rights = $_.FileSystemRights.ToString(); Type = $_.AccessControlType.ToString() } })",
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            env: { ...process.env, CLAUDE_SHARE_TEST_ACL_PATH: target },
          },
        ),
      );
      const sid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8",
        windowsHide: true,
      }).match(/S-1-5-[0-9-]+/)![0];
      assert.deepEqual(acl, [{ Sid: sid, Inherited: false, Rights: "FullControl", Type: "Allow" }]);
    } else {
      assert.equal(fs.statSync(target).mode & 0o777, 0o600);
      assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows npm launcher preserves literal arguments through a path containing spaces", async () => {
  const root = privateTempDir("claude-share-test-command ");
  try {
    const packageDir = path.join(root, "node_modules", "@anthropic-ai", "claude-code");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(root, "claude.cmd"), "THIS MUST NEVER BE EXECUTED");
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ bin: { claude: "cli.cjs" } }),
    );
    fs.writeFileSync(
      path.join(packageDir, "cli.cjs"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
    );
    const executable = resolveExecutable("claude", { platform: "win32", searchPath: root });
    const args = ['quote " & | < > % $', "C:\\path with spaces\\", "$(not-a-command)", ""];
    const child = spawnExecutable(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += chunk));
    const [code] = await once(child, "close");
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(output), args);
    fs.writeFileSync(path.join(root, "claude.exe"), "");
    assert.equal(
      resolveExecutable("claude", { platform: "win32", searchPath: root }).command,
      path.join(root, "claude.exe"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("child environment removes alternate authentication and proxy exclusions", () => {
  const parent = {
    https_proxy: "evil",
    NO_PROXY: "*",
    ANTHROPIC_AUTH_TOKEN: "real",
    ANTHROPIC_BASE_URL: "http://evil",
    NODE_OPTIONS: "--require malicious.cjs",
    CLAUDE_CODE_USE_BEDROCK: "1",
    KEEP: "yes",
  };
  const child = receiverEnvironment(parent, "https://proxy", "certificate.pem", "profile");
  assert.equal(child.https_proxy, undefined);
  assert.equal(child.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(child.NODE_OPTIONS, undefined);
  assert.equal(child.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(child.NO_PROXY, "");
  assert.equal(child.KEEP, "yes");
  assert.equal(parent.ANTHROPIC_AUTH_TOKEN, "real");
});
for (const duration of [60_000, Infinity]) {
  test(`pairing, reconnecting, isolated profiles and cleanup (${duration === Infinity ? "infinite" : "timed"})`, async () => {
    const fixture = certificates("localhost");
    const root = privateTempDir("claude-share-test-receiver-");
    const regularConfig = path.join(root, ".claude.json");
    fs.writeFileSync(regularConfig, '{"normal":"untouched"}');
    const original = fs.readFileSync(regularConfig, "utf8");
    const session = createSession(duration);
    const urls = { public: null, lan: "https://127.0.0.1" };
    const app = createApiApp(urls, fixture.caPem, null, "Linux fixture");
    const server = https.createServer(fixture, async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers))
          if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
        const response = await app.fetch(
          new Request(urls.lan + req.url, {
            method: req.method,
            headers,
            body: req.method === "GET" ? undefined : Buffer.concat(chunks).toString(),
          }),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    urls.lan = "https://127.0.0.1:" + (server.address() as net.AddressInfo).port;
    const before = new Set(
      fs.readdirSync(path.dirname(root)).filter((f) => f.startsWith("claude-share-ca-")),
    );
    try {
      const response = await apiFetch(urls.lan + "/pair", {
        method: "POST",
        rejectUnauthorized: false,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: session.pairingCode.slice(0, 5),
          name: "Windows/macOS fixture",
        }),
      });
      assert.equal(response.status, 200);
      const paired = (await response.json()) as { blob: string; machineId: string };
      const connection = decryptBlob(paired.blob, session.pairingCode);
      assert.equal(connection.sharedUntil, session.sharedUntil.toISOString());
      assert.equal(connection.proxyUser, paired.machineId);
      const meta = { ...connection, id: paired.machineId };
      const executable = {
        command: process.execPath,
        args: [path.resolve("tests/fixtures/fake-claude.cjs")],
      };
      const output = path.join(root, "child.json");
      const options = { executable, profileRoot: path.join(root, "profiles"), quiet: true };
      const code = await launchClaude(
        urls.lan,
        fixture.caPem,
        meta,
        ["--output", output, "--exit", "17", '" & | < > % $'],
        null,
        options,
      );
      assert.equal(code, 17);
      process.exitCode = 0;
      const snapshot = JSON.parse(fs.readFileSync(output, "utf8"));
      assert.equal(snapshot.certExists, true);
      assert.equal(fs.existsSync(snapshot.cert), false);
      assert.equal(snapshot.placeholder, "claude-share-placeholder");
      assert.equal(snapshot.profile, path.join(root, "profiles", paired.machineId));
      assert.equal(fs.readFileSync(regularConfig, "utf8"), original);
      const waitOutput = path.join(root, "waiting-child.json");
      const interrupted = launchClaude(
        urls.lan,
        fixture.caPem,
        meta,
        ["--output", waitOutput, "--wait"],
        null,
        options,
      );
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(waitOutput) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fs.existsSync(waitOutput), true);
      process.emit("SIGINT");
      assert.equal(await interrupted, 130);
      process.exitCode = 0;
      assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(waitOutput, "utf8")).cert), false);
      fs.writeFileSync(path.join(snapshot.profile, "history-fixture"), "preserved");
      assert.equal(
        await launchClaude(
          urls.lan,
          fixture.caPem,
          meta,
          ["--output", output, "--exit", "0"],
          null,
          options,
        ),
        0,
      );
      assert.equal(
        fs.readFileSync(path.join(snapshot.profile, "history-fixture"), "utf8"),
        "preserved",
      );
      await assert.rejects(
        launchClaude(urls.lan, fixture.caPem, meta, [], null, {
          ...options,
          executable: { command: path.join(root, "missing-command"), args: [] },
        }),
      );
      assert.equal(
        [...getSession()!.machines.get(paired.machineId)!.sessions.values()].every(
          (s) => !s.active,
        ),
        true,
      );
      const after = fs
        .readdirSync(path.dirname(root))
        .filter((f) => f.startsWith("claude-share-ca-"));
      assert.deepEqual(new Set(after), before);
      await assert.rejects(
        apiFetch(urls.lan + "/health", { ca: fixture.caPem, signal: AbortSignal.abort() }),
        /Aborted/,
      );
    } finally {
      process.exitCode = 0;
      server.closeAllConnections();
      server.close();
      destroySession();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
test("expired token fails closed and rereading valid credentials restores service", async () => {
  const root = privateTempDir("claude-share-test-token-");
  try {
    fs.writeFileSync(
      path.join(root, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "dummy", expiresAt: Date.now() - 1 } }),
    );
    await initToken(root);
    assert.throws(getAccessToken, /expired/);
    fs.writeFileSync(
      path.join(root, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "dummy-new", expiresAt: Date.now() + 60_000 },
      }),
    );
    await initToken(root);
    assert.equal(getAccessToken(), "dummy-new");
  } finally {
    stopTokenRefresh();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
