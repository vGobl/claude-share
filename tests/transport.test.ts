import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { createPortDetector } from "../claude-share/port/detector";
import { boundedDownload, startTunnel } from "../claude-share/tunnel";
import { privateTempDir } from "../shared/private-files";
test("fragmented CONNECT bytes are replayed intact", async () => {
  let received = "";
  const server = createPortDetector({
    onConnect(socket) {
      socket.on("data", (chunk) => {
        received += chunk;
        socket.end();
      });
      socket.resume();
    },
    onHttp(socket) {
      socket.end("wrong");
    },
    onTls(socket) {
      socket.end("wrong");
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1");
  client.on("error", () => {});
  try {
    await once(client, "connect");
    client.write("CON");
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.write("NECT example.com:443 HTTP/1.1\r\n\r\n");
    client.resume();
    await once(client, "close");
    assert.equal(received, "CONNECT example.com:443 HTTP/1.1\r\n\r\n");
  } finally {
    client.destroy();
    server.close();
  }
});
test("bore downloads bound redirects, size and trusted origins", async () => {
  const redirect = async () => new Response(null, { status: 302, headers: { location: "/again" } });
  await assert.rejects(boundedDownload("https://github.com/start", 100, redirect), /redirect/);
  const huge = async () => new Response("a".repeat(101));
  await assert.rejects(boundedDownload("https://github.com/start", 100, huge), /large/);
  const insecure = async () =>
    new Response(null, { status: 302, headers: { location: "http://github.com/insecure" } });
  await assert.rejects(boundedDownload("https://github.com/start", 100, insecure), /Untrusted/);
  assert.equal(
    (
      await boundedDownload("https://github.com/start", 100, async () => new Response("ok"))
    ).toString(),
    "ok",
  );
});

test("bore reads runtime configuration and waits for complete port output", async () => {
  const root = privateTempDir("claude-share-test-bore-");
  const previous = {
    server: process.env.BORE_SERVER,
    password: process.env.BORE_PASSWORD,
    output: process.env.CLAUDE_SHARE_TEST_BORE_OUTPUT,
  };
  try {
    for (const host of ["first.example", "second.example"]) {
      const output = path.join(root, host + ".json");
      process.env.BORE_SERVER = host;
      process.env.BORE_PASSWORD = "DUMMY_BORE_PASSWORD";
      process.env.CLAUDE_SHARE_TEST_BORE_OUTPUT = output;
      const tunnel = await startTunnel(2586, undefined, {
        command: process.execPath,
        args: [path.resolve("tests/fixtures/fake-bore.cjs")],
      });
      try {
        assert.equal(tunnel.publicUrl, "https://" + host + ":12345");
        assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), [
          "local",
          "2586",
          "--to",
          host,
          "--secret",
          "DUMMY_BORE_PASSWORD",
        ]);
      } finally {
        tunnel.close();
      }
    }
  } finally {
    for (const [key, value] of [
      ["BORE_SERVER", previous.server],
      ["BORE_PASSWORD", previous.password],
      ["CLAUDE_SHARE_TEST_BORE_OUTPUT", previous.output],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
