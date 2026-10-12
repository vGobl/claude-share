#!/usr/bin/env node
import "@shared/patch-console";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import * as p from "@clack/prompts";
import { serve } from "@hono/node-server";
import { checkForUpdate, forceUpgrade } from "@shared/checkVersion";
import { platform } from "@shared/platforms";
import { render } from "ink";
import React from "react";

import pkg from "../package.json";
import { logger } from "./logger";

if (process.argv.includes("-v") || process.argv.includes("--version")) {
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", err);
  cleanupAll();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", reason);
  cleanupAll();
  process.exit(1);
});

// Exits with a clear error if the platform is unsupported
platform();
if (process.platform === "win32") {
  process.stderr.write("Run claude-share on the Linux sharer; Windows supports claude-connect.\n");
  process.exit(1);
}

import { parsePort } from "@shared/port";

import { createPortDetector, sniffSocket } from "./port/detector";
import { createMitmProxy } from "./proxy/mitm";
import { normalizeHostname } from "./proxy/policy";
import { initToken, stopTokenRefresh } from "./proxy/token";
import { verifyTokenOrExit } from "./proxy/verifyToken";
import { createApiApp } from "./server/index";
import {
  createSession,
  scheduleSessionExpiry,
  destroySession,
  getSession,
  checkMachineAuth,
  type SharerAccount,
} from "./session/manager";
import { App } from "./tui/App";
import { isBoreInstalled, installBore, startTunnel } from "./tunnel/index";

const CLAUDE_SHARE_CONFIG = path.join(os.homedir(), ".claude-share", "config.json");

function hasAgreedToTerms(): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(CLAUDE_SHARE_CONFIG, "utf8")) as Record<string, unknown>;
    return cfg["hasShareTermsAgreed"] === true;
  } catch {
    return false;
  }
}

function saveTermsAgreed(): void {
  const dir = path.dirname(CLAUDE_SHARE_CONFIG);
  fs.mkdirSync(dir, { recursive: true });
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CLAUDE_SHARE_CONFIG, "utf8")) as Record<string, unknown>;
  } catch {}
  cfg["hasShareTermsAgreed"] = true;
  fs.writeFileSync(CLAUDE_SHARE_CONFIG, JSON.stringify(cfg, null, 2), {
    mode: 0o600,
  });
}

function readSharerAccount(): SharerAccount | null {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const acct = config["oauthAccount"] as Record<string, string> | undefined;
    if (!acct) return null;
    return {
      emailAddress: acct["emailAddress"] ?? "",
      displayName: acct["displayName"] ?? "",
      organizationName: acct["organizationName"] ?? "",
    };
  } catch {
    return null;
  }
}

async function getSystemName(): Promise<string> {
  return platform().getSystemName();
}

function getLanIp(): string | null {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

async function promptDuration(): Promise<number> {
  const choice = await p.select({
    message: "How long do you want to share?",
    options: [
      { value: 6 * 60 * 60 * 1000, label: "6 hours" },
      { value: 24 * 60 * 60 * 1000, label: "24 hours" },
      { value: 7 * 24 * 60 * 60 * 1000, label: "1 week" },
      { value: Infinity, label: "Infinite (until stopped)" },
    ],
  });

  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return choice as number;
}

const cleanupTasks: Array<() => void> = [];
const activeSockets = new Set<net.Socket>();
function cleanupAll() {
  for (const socket of activeSockets) socket.destroy();
  for (const task of cleanupTasks.splice(0).reverse()) {
    try {
      task();
    } catch {}
  }
  stopTokenRefresh();
  destroySession();
}
async function main() {
  if (process.argv.includes("--upgrade")) {
    await forceUpgrade();
    return;
  }

  await checkForUpdate();

  p.intro("claude-share");

  if (!hasAgreedToTerms()) {
    p.log.warn(
      "Heads up: You're sharing your Claude Code at your own risk.\n" +
        "This is an open-source project and we are not liable for any damage or\n" +
        "suspension of your Claude Code subscription. Make sure you trust the\n" +
        "person you are sharing your subscription with.\n\n" +
        "This CLI is built to share your Claude Code with a few friends in need.\n" +
        "Sharing it with a lot of people can be a direct recipe for an account ban.\n" +
        "We love Claude Code and the purpose of this CLI is to help your friends\n" +
        "sometimes when they've hit their limit or just want to try it out.",
    );
    const agreed = await p.confirm({
      message: "Do you understand and want to continue?",
      initialValue: false,
    });
    if (p.isCancel(agreed) || !agreed) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    saveTermsAgreed();
  }

  const envTunnel = process.env.TUNNEL !== "0" && process.env.TUNNEL !== "false";

  let boreReady = false;
  if (!envTunnel) {
    p.log.info("TUNNEL=0 — sharing on LAN only.");
  } else {
    const shareMode = await p.select({
      message: "How do you want to share?",
      options: [
        {
          value: "internet",
          label: "Internet",
          hint: "EXPERIMENTAL: TCP tunnels via bore",
        },
        {
          value: "lan",
          label: "LAN only",
          hint: "Both machines require to be on the same network",
        },
      ],
    });
    if (p.isCancel(shareMode)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    if (shareMode === "internet") {
      if (await isBoreInstalled()) {
        boreReady = true;
      } else {
        const consent = await p.confirm({
          message: "Download and install bore on this sharer?",
          initialValue: false,
        });
        if (!p.isCancel(consent) && consent)
          try {
            await installBore();
            boreReady = true;
          } catch {
            p.log.warn("Could not install bore — sharing on LAN only.");
          }
      }
    }
  }

  await initToken();
  await verifyTokenOrExit();

  const duration = await promptDuration();
  const session = createSession(duration);
  cleanupTasks.push(
    scheduleSessionExpiry(session, () => {
      cleanupAll();
      process.exit(0);
    }),
  );

  const DEFAULT_PORT = 2586;
  const argv = process.argv.slice(2);
  const portIdx = argv.findIndex((a) => a === "--port" || a === "-p");
  const portEq = argv.find((a) => a.startsWith("--port=") || a.startsWith("-p="));
  if (portIdx !== -1 && !argv[portIdx + 1]) throw new Error("--port requires a value");
  let PORT = parsePort(
    portEq
      ? portEq.split("=")[1]
      : portIdx !== -1
        ? argv[portIdx + 1]
        : (process.env.PORT ?? String(DEFAULT_PORT)),
  );
  const lanIp = getLanIp();
  let lanUrl = lanIp ? `https://${lanIp}:${PORT}` : null;
  let loopbackUrl = `https://localhost:${PORT}`;

  const boreServer = normalizeHostname(process.env.BORE_SERVER ?? "bore.pub");

  // MITM proxy resolves only after its RSA CA is ready (no race on CONNECT)
  const mitmProxy = await createMitmProxy(
    lanIp,
    (auth) => {
      const session = getSession();
      return session ? checkMachineAuth(session, auth) : false;
    },
    boreServer,
  );
  cleanupTasks.push(() => mitmProxy.close());
  logger.info("MITM proxy ready");

  // Mutable — publicUrl is filled in after the tunnel starts
  const urls = { public: null as string | null, lan: lanUrl };
  const sharerAccount = readSharerAccount();
  const systemName = await getSystemName();

  // Hono API on a random localhost-only port — not exposed externally
  const apiApp = createApiApp(urls, mitmProxy.caCertPem, sharerAccount, systemName);
  const honoServer = serve({ fetch: apiApp.fetch, port: 0, hostname: "127.0.0.1" });
  cleanupTasks.push(() => honoServer.close());
  await new Promise<void>((resolve, reject) => {
    if (honoServer.listening) resolve();
    else {
      honoServer.once("listening", resolve);
      honoServer.once("error", reject);
    }
  });
  const API_PORT = (honoServer.address() as net.AddressInfo).port;

  // Internal TLS termination server: accepts raw TLS bytes from the detector,
  // does the handshake, then routes by sniffing the first decrypted bytes:
  //   CONNECT → MITM proxy (HTTPS proxy tunnel)
  //   anything else → Hono API port (regular HTTPS API call)
  const tlsTermServer = tls.createServer(
    {
      cert: mitmProxy.serverCert.certPem,
      key: mitmProxy.serverCert.keyPem,
      handshakeTimeout: 5000,
    },
    (tlsSocket) => {
      tlsSocket.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
          logger.error("[tls] socket error", err);
        }
      });

      const pipeApi = (socket: net.Socket) => {
        const upstream = net.connect(API_PORT, "127.0.0.1");
        socket.pipe(upstream);
        upstream.pipe(socket);
        upstream.on("error", () => socket.destroy());
        socket.on("close", () => upstream.destroy());
        upstream.on("close", () => socket.destroy());
      };
      sniffSocket(
        tlsSocket,
        { onConnect: (socket) => mitmProxy.handleSocket(socket), onHttp: pipeApi, onTls: pipeApi },
        false,
      );
    },
  );
  cleanupTasks.push(() => tlsTermServer.close());
  const TLS_TERM_PORT = await new Promise<number>((resolve, reject) => {
    tlsTermServer.once("error", reject);
    tlsTermServer.listen(0, "127.0.0.1", () => {
      resolve((tlsTermServer.address() as net.AddressInfo).port);
    });
  });

  // Single public port: TLS ClientHello → TLS terminator (handles both HTTPS API
  // and HTTPS proxy CONNECT after decryption). Plain HTTP and bare CONNECT are
  // rejected — all traffic must be wrapped in TLS.
  const detector = createPortDetector({
    onConnect: (socket) => {
      socket.write("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n");
      socket.end();
    },
    onTls: (socket) => {
      const upstream = net.connect(TLS_TERM_PORT, "127.0.0.1");
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      upstream.on("close", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
    },
    onHttp: (socket) => {
      socket.write("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n");
      socket.end();
    },
  });

  cleanupTasks.push(() => detector.close());
  detector.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  });
  async function listen(port: number) {
    await new Promise<void>((resolve, reject) => {
      const failed = (err: Error) => {
        detector.removeListener("listening", ready);
        reject(err);
      };
      const ready = () => {
        detector.removeListener("error", failed);
        resolve();
      };
      detector.once("error", failed);
      detector.once("listening", ready);
      detector.listen(port);
    });
  }
  try {
    await listen(PORT);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    await listen(0);
    PORT = (detector.address() as net.AddressInfo).port;
    lanUrl = lanIp ? `https://${lanIp}:${PORT}` : null;
    loopbackUrl = `https://localhost:${PORT}`;
    urls.lan = lanUrl;
    p.log.info(`Requested port is in use; using ${PORT} instead.`);
  }
  logger.info(`Listening on port ${PORT}`);

  let tunnel: Awaited<ReturnType<typeof startTunnel>>;
  let publicUrl: string | null = null;
  let tunnelDown = false;
  let tunnelStartedAt: Date | null = null;
  let rerenderApp: ((node: React.ReactElement) => void) | null = null;

  if (boreReady) {
    logger.info("Starting bore tunnel");
    try {
      tunnel = await startTunnel(PORT, () => {
        tunnelDown = true;
        logger.error("bore tunnel disconnected unexpectedly");
        rerenderApp?.(makeAppElement());
      });
      publicUrl = tunnel.publicUrl;
      urls.public = publicUrl;
      if (publicUrl) {
        tunnelStartedAt = new Date();
        logger.info(`Tunnel active: ${publicUrl}`);
      } else {
        logger.warn("Unable to generate public URL: bore did not return a port");
      }
    } catch (err) {
      logger.warn("Could not start bore tunnel", err);
      tunnel = { publicUrl: null, close: () => {} };
    }
  } else {
    tunnel = { publicUrl: null, close: () => {} };
  }

  cleanupTasks.push(() => tunnel.close());
  function cleanup() {
    cleanupAll();
  }

  function makeAppElement(): React.ReactElement {
    return React.createElement(App, {
      publicUrl,
      loopbackUrl,
      lanUrl,
      localPort: PORT,
      sharedUntil: session.sharedUntil,
      getSession: () => getSession(),
      tunnelDown,
      tunnelStartedAt,
      onExit: () => {
        cleanup();
        process.exit(0);
      },
    });
  }

  const { unmount, rerender } = render(makeAppElement());
  rerenderApp = rerender;
  cleanupTasks.push(() => unmount());

  process.on("SIGINT", () => {
    unmount();
    cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    unmount();
    cleanup();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error("Fatal error in main", err);
  p.log.error(err.message);
  cleanupAll();
  process.exit(1);
});
