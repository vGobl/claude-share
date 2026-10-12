import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { parseArgs } from "../claude-connect/args";
import { decodePairingKey, parseConnectUrl, decryptBlob } from "../claude-connect/pairing";
import {
  isPublicAddress,
  parseAuthority,
  resolveDestination,
  requestAllowed,
  validateRequestDestination,
  passthroughDomains,
} from "../claude-share/proxy/policy";
import { createApiApp } from "../claude-share/server";
import {
  createSession,
  addMachine,
  authenticateMachine,
  regeneratePairingCode,
  checkPairingCode,
  pairingLimited,
  recordPairingFailure,
  encryptConnectionFile,
  destroySession,
  isSessionExpired,
  scheduleSessionExpiry,
} from "../claude-share/session/manager";
import { toBase58, fromBase58 } from "../shared/base58";
import { parsePort } from "../shared/port";
import { UNLIMITED_SHARED_UNTIL } from "../shared/sharing-expiry";
import { isoDate } from "../shared/validation";

test("Base58 preserves every leading byte, zero keys and random keys", () => {
  for (let first = 0; first < 256; first++) {
    const key = Buffer.alloc(32, 7);
    key[0] = first;
    assert.deepEqual(Buffer.from(fromBase58(toBase58(key))), key);
    assert.deepEqual(Buffer.from(decodePairingKey(toBase58(key))), key);
  }
  for (let i = 0; i < 1000; i++) {
    const key = randomBytes(32);
    assert.deepEqual(Buffer.from(fromBase58(toBase58(key))), key);
  }
  const zero = Buffer.alloc(32);
  assert.deepEqual(Buffer.from(decodePairingKey(toBase58(zero))), zero);
  assert.throws(() => decodePairingKey(toBase58(Buffer.alloc(33, 1))));
  assert.throws(() => decodePairingKey("0".repeat(44)));
  assert.throws(() => decryptBlob("zz".repeat(40), toBase58(zero)));
});
test("URL and argument parsing rejects malformed input without losing Claude args", () => {
  const code = toBase58(randomBytes(32));
  const url = "claudeshare://127.0.0.1:2586/connect/" + code;
  assert.equal(parseConnectUrl(url)?.serverUrl, "https://127.0.0.1:2586");
  assert.equal(parseConnectUrl("https://user:password@host/connect/" + code), null);
  assert.equal(parseConnectUrl(url + "?secret=oops"), null);
  assert.deepEqual(parseArgs(["--share", url, "-p", 'quote " & | < > % $']).claudeArgs, [
    "-p",
    'quote " & | < > % $',
  ]);
  assert.equal(parseArgs(["--share=" + url]).share, url);
  assert.throws(() => parseArgs(["--share"]));
  assert.throws(() => parseArgs(["--share", "--list"]));
  assert.deepEqual(parseArgs(["--", "--share", "literal"]).claudeArgs, ["--share", "literal"]);
  for (const invalid of ["0", "-1", "65536", "12oops", "1.1", ""])
    assert.throws(() => parsePort(invalid));
});
test("proxy destinations and exact route rules fail closed", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.throws(() => parseAuthority("api.anthropic.com:80"));
  assert.throws(() => parseAuthority("127.0.0.1:443"));
  assert.throws(() => passthroughDomains("*.example.com"));
  await assert.rejects(
    resolveDestination("api.anthropic.com", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
  );
  const destination = await resolveDestination("api.anthropic.com", async () => [
    { address: "8.8.8.8", family: 4 },
  ]);
  const context = {
    isSSL: true,
    clientToProxyRequest: {
      headers: { host: destination.hostname },
      method: "POST",
      url: "/v1/messages",
    },
    proxyToServerRequestOptions: { host: destination.hostname, port: 443 },
  };
  validateRequestDestination(context, destination);
  assert.throws(() => validateRequestDestination({ ...context, isSSL: false }, destination));
  assert.throws(() =>
    validateRequestDestination(
      { ...context, proxyToServerRequestOptions: { host: "evil.example", port: 443 } },
      destination,
    ),
  );
  assert.equal(requestAllowed(destination.hostname, "POST", "/v1/messages?stream=true"), true);
  for (const route of [
    "/v1/messages/extra",
    "/v1/messagesX",
    "/v1/files",
    "/v1/../files",
    "/v1/%2e%2e/files",
    "//evil.example/v1/messages",
  ])
    assert.equal(requestAllowed(destination.hostname, "POST", route), false);
});
test("infinite sharing skips timers and keeps authentication and revocation enforced", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const timeouts = t.mock.method(globalThis, "setTimeout");
  const finite = createSession(60_000);
  const cancelFinite = scheduleSessionExpiry(finite, () => assert.fail("Cancelled timer fired"));
  assert.equal(timeouts.mock.callCount(), 1);
  assert.equal(timeouts.mock.calls[0].arguments[1], 60_000);
  cancelFinite();

  const session = createSession(Infinity);
  try {
    const cancel = scheduleSessionExpiry(session, () => assert.fail("Infinite session expired"));
    assert.equal(timeouts.mock.callCount(), 1);
    cancel();
    cancel();
    assert.equal(isoDate(session.sharedUntil.toISOString()), UNLIMITED_SHARED_UNTIL);
    const machine = addMachine(session, "Unlimited fixture");
    const auth = "Basic " + Buffer.from(machine.id + ":" + machine.proxyPass).toString("base64");
    t.mock.method(Date, "now", () => Date.UTC(2200, 0, 1));
    assert.equal(isSessionExpired(finite), true);
    assert.equal(isSessionExpired(session), false);
    assert.equal(authenticateMachine(session, auth)?.id, machine.id);
    assert.equal(authenticateMachine(session, "Basic invalid"), null);
    const app = createApiApp(
      { public: null, lan: "https://127.0.0.1:2586" },
      "fixture",
      null,
      "Linux",
    );
    const request = () =>
      app.request("/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Proxy-Authorization": auth },
        body: JSON.stringify({ machineId: machine.id }),
      });
    assert.equal((await request()).status, 200);
    session.status = "revoked";
    assert.equal(authenticateMachine(session, auth), null);
    assert.equal((await request()).status, 407);
  } finally {
    destroySession();
  }
});

test("pairing encryption, API ownership, expiry and global throttling", async () => {
  const session = createSession(60_000);
  const key = session.key;
  const a = addMachine(session, "A");
  regeneratePairingCode(session);
  assert.deepEqual(Buffer.from(key), Buffer.alloc(32));
  assert.equal(checkPairingCode(session, "\u{1F600}\u{1F600}a"), false);
  const b = addMachine(session, "B");
  const auth = "Basic " + Buffer.from(a.id + ":" + a.proxyPass).toString("base64");
  assert.equal(authenticateMachine(session, auth)?.id, a.id);
  const app = createApiApp(
    { public: null, lan: "https://127.0.0.1:2586" },
    "fixture",
    null,
    "Linux",
  );
  const request = (route: string, data: unknown) =>
    app.request(route, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Proxy-Authorization": auth },
      body: JSON.stringify(data),
    });
  assert.equal((await request("/session/start", { machineId: b.id })).status, 403);
  assert.equal((await request("/session/start", { machineId: a.id })).status, 200);
  assert.equal((await request("/session/start", { machineId: 7 })).status, 400);
  const blob = encryptConnectionFile(session, {
    publicServerUrl: null,
    lanServerUrl: "https://127.0.0.1:2586",
    sessionId: session.id,
    sharedUntil: session.sharedUntil.toISOString(),
    caPem: "invalid",
    sharerAccount: null,
    systemName: "Linux",
    proxyUser: a.id,
    proxyPass: a.proxyPass,
  });
  assert.throws(() => decryptBlob(blob, session.pairingCode), /certificate/i);
  session.sharedUntil = new Date(0);
  assert.equal(authenticateMachine(session, auth), null);
  assert.equal((await request("/session/start", { machineId: a.id })).status, 407);
  const future = Date.now() + 61_000;
  pairingLimited(future);
  for (let i = 0; i < 20; i++) recordPairingFailure();
  regeneratePairingCode(session);
  assert.equal(pairingLimited(), true);
  assert.equal(
    (
      await app.request("/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "different-ip" },
        body: JSON.stringify({ code: "wrong", name: "test" }),
      })
    ).status,
    429,
  );
  assert.equal(pairingLimited(Date.now() + 61_000), false);
  destroySession();
});
