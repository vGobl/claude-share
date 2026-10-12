import { record, text, uuid } from "@shared/validation";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import {
  getSession,
  checkPairingCode,
  authenticateMachine,
  addMachine,
  encryptConnectionFile,
  isSessionExpired,
  addMachineSession,
  endMachineSession,
  heartbeatMachineSession,
  pairingLimited,
  recordPairingFailure,
  type ConnectionFile,
  type SharerAccount,
} from "../session/manager";

interface Urls {
  public: string | null;
  lan: string | null;
}
export function createApiApp(
  urls: Urls,
  caPem: string,
  sharerAccount: SharerAccount | null,
  systemName: string,
) {
  const app = new Hono<{ Variables: { machineId: string } }>();
  app.use(
    "*",
    bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "Request body too large" }, 413) }),
  );
  app.onError((_err, c) => {
    if (c.req.path === "/pair") recordPairingFailure();
    return c.json({ error: "Invalid request body" }, 400);
  });
  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.path === "/pair" || c.req.path.startsWith("/connect/"))
      return next();
    const session = getSession();
    const machine =
      session && authenticateMachine(session, c.req.header("proxy-authorization") ?? "");
    if (!machine) return c.json({ error: "Unauthorized or expired session" }, 407);
    c.set("machineId", machine.id);
    await next();
  });
  app.get("/health", (c) => {
    const session = getSession();
    return c.json({
      ok: true,
      sessionActive: !!session && !isSessionExpired(session),
      sessionId: session?.id ?? null,
    });
  });
  app.get("/connect/:code", (c) =>
    c.text(
      "Paste the original connect link into claude-connect. Keep it private; it contains the pairing key.",
    ),
  );
  app.post("/pair", async (c) => {
    if (pairingLimited())
      return c.json({ error: "Too many pairing failures; retry in one minute" }, 429);
    const session = getSession();
    if (!session || isSessionExpired(session)) return c.json({ error: "No active session" }, 503);
    const body = record(await c.req.json());
    const code = text(body.code, "pairing prefix", 5);
    const name = text(body.name ?? "unknown device", "device name", 128).trim();
    if (!name) throw new Error("Empty device name");
    if (!checkPairingCode(session, code))
      return c.json({ error: "Invalid or already used pairing code" }, 401);
    const machine = addMachine(session, name);
    const file: ConnectionFile = {
      publicServerUrl: urls.public,
      lanServerUrl: urls.lan,
      sessionId: session.id,
      sharedUntil: session.sharedUntil.toISOString(),
      caPem,
      sharerAccount,
      systemName,
      proxyUser: machine.id,
      proxyPass: machine.proxyPass,
    };
    return c.json({ blob: encryptConnectionFile(session, file), machineId: machine.id });
  });
  for (const endpoint of ["start", "end", "heartbeat"] as const) {
    app.post("/session/" + endpoint, async (c) => {
      const session = getSession();
      if (!session || isSessionExpired(session)) return c.json({ error: "No active session" }, 503);
      const body = record(await c.req.json());
      const machineId = uuid(body.machineId);
      if (machineId !== c.get("machineId"))
        return c.json({ error: "Session belongs to another machine" }, 403);
      if (endpoint === "start") {
        const ms = addMachineSession(session, machineId);
        return ms
          ? c.json({ ok: true, sessionId: ms.id })
          : c.json({ error: "Machine not found" }, 404);
      }
      const sessionId = uuid(body.sessionId);
      const success =
        endpoint === "end"
          ? endMachineSession(session, machineId, sessionId)
          : heartbeatMachineSession(session, machineId, sessionId);
      return success
        ? c.json({ ok: true })
        : c.json({ error: "Session not found or inactive" }, 404);
    });
  }
  app.get("/machines", (c) => {
    const session = getSession()!;
    const machine = session.machines.get(c.get("machineId"))!;
    return c.json({
      machines: [
        {
          id: machine.id,
          name: machine.name,
          pairedAt: machine.pairedAt.toISOString(),
          sessions: [...machine.sessions.values()].map((s) => ({
            id: s.id,
            startedAt: s.startedAt.toISOString(),
            lastActiveAt: s.lastActiveAt.toISOString(),
            active: s.active,
          })),
        },
      ],
      sharedUntil: session.sharedUntil.toISOString(),
    });
  });
  return app;
}
