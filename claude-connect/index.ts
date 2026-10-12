#!/usr/bin/env node
import "@shared/patch-console";
import * as p from "@clack/prompts";
import { checkForUpdate, forceUpgrade } from "@shared/checkVersion";
import { platform } from "@shared/platforms";

import pkg from "../package.json";
import { parseArgs } from "./args";

const wrapperArgs = process.argv.slice(2);
const separator = wrapperArgs.indexOf("--");
const ownArgs = separator < 0 ? wrapperArgs : wrapperArgs.slice(0, separator);
if (ownArgs.includes("-v") || ownArgs.includes("--version")) {
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

if (ownArgs.includes("--upgrade")) {
  await forceUpgrade();
  process.exit(0);
}

import { listFlow } from "./flows/list";
import { pairFlow } from "./flows/pair";
import { reconnectFlow } from "./flows/reconnect";
import { resolveActiveUrl } from "./health";
import { launchClaude } from "./launch";
import { logger } from "./logger";
import { parseConnectUrl } from "./pairing";
import {
  findConnectionByServerUrl,
  hasAgreedToTerms,
  loadConnections,
  pruneExpiredConnections,
  saveTermsAgreed,
} from "./storage";

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", err);
  p.log.error(err.message);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", reason);
  p.log.error(reason instanceof Error ? reason.message : String(reason));
  process.exit(1);
});

// Exits with a clear error if the platform is unsupported
platform();

await checkForUpdate();

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

// Identify which arg indices belong to claude-connect itself
let parsedArgs: ReturnType<typeof parseArgs>;
try {
  parsedArgs = parseArgs(args);
} catch (err) {
  p.log.error((err as Error).message);
  process.exit(1);
}
const { claudeArgs } = parsedArgs;

pruneExpiredConnections();

if (!hasAgreedToTerms()) {
  p.intro("claude-connect");
  p.log.warn(
    "Heads up: you're connecting to someone else's Claude Code at your own discretion.\n" +
      "The proxy decrypts Claude traffic on the sharer's machine.\n" +
      "Please connect\n" +
      "only to people you trust.\n\n" +
      "Once connected, you might still see your own email or organization name shown\n" +
      "in Claude Code. That's expected behavior and safe to ignore.",
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

// ── Dispatch ──────────────────────────────────────────────────────────────────

if (parsedArgs.list) {
  await listFlow();
} else if (parsedArgs.reconnect !== undefined) {
  await reconnectFlow(parsedArgs.reconnect || undefined, claudeArgs);
} else if (parsedArgs.share) {
  const connectUrl = parsedArgs.share.trim();
  const parsed = parseConnectUrl(connectUrl);
  if (!parsed) {
    p.log.error("Invalid --share URL. Expected: claudeshare://host:port/connect/CODE");
    process.exit(1);
  }

  // Check if we already have credentials for this sharer
  const existing = findConnectionByServerUrl(parsed.serverUrl);
  if (existing) {
    const resolved = await resolveActiveUrl(existing);
    if (resolved.alive && resolved.sessionId === existing.sessionId) {
      // Same session still running — skip pairing entirely
      p.intro("claude-connect");
      p.log.info(`Resuming existing connection for ${existing.systemName}`);
      await launchClaude(
        resolved.url,
        existing.caPem,
        existing,
        claudeArgs,
        existing.sharerAccount ?? null,
      );
    } else {
      // Session changed, server restarted, or TLS cert rotated (sharer restart generates
      // a new CA, so the old caPem fails verification and health returns alive=false).
      // The user provided an explicit new URL, so always attempt fresh pairing — if the
      // sharer is truly offline, pairFlow will fail with a network error naturally.
      await pairFlow(parsed, claudeArgs);
    }
  } else {
    await pairFlow(parsed, claudeArgs);
  }
} else {
  // No --share flag: check for active saved connections first
  const saved = loadConnections();

  if (saved.length > 0) {
    const spin = p.spinner();
    spin.start("Checking active sharers...");

    const results = await Promise.all(
      saved.map(async (c) => {
        const resolved = await resolveActiveUrl(c);
        return {
          conn: c,
          url: resolved.url,
          alive: resolved.alive && resolved.sessionId === c.sessionId,
        };
      }),
    );

    spin.stop();

    const active = results.filter((r) => r.alive);

    if (active.length > 0) {
      p.intro("claude-connect");
      const pick = await p.select({
        message: "Connect to an active sharer or pair with a new one:",
        options: [
          ...active.map((r) => ({
            value: r.conn.id,
            label: r.conn.systemName,
            hint: r.url,
          })),
          {
            value: "__new__",
            label: "Pair with a new sharer…",
            hint: "enter a connect URL",
          },
        ],
      });
      if (p.isCancel(pick)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      if (pick === "__new__") {
        await pairFlow(undefined, claudeArgs);
      } else {
        const chosen = active.find((r) => r.conn.id === pick)!;
        await launchClaude(
          chosen.url,
          chosen.conn.caPem,
          chosen.conn,
          claudeArgs,
          chosen.conn.sharerAccount ?? null,
        );
      }
    } else {
      await pairFlow(undefined, claudeArgs);
    }
  } else {
    await pairFlow(undefined, claudeArgs);
  }
}
