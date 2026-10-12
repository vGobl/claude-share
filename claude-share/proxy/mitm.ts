import fs from "node:fs";
import type { Agent } from "node:https";
import net from "node:net";
import path from "node:path";

import { privateTempDir } from "@shared/private-files";
import { Proxy } from "http-mitm-proxy";

import { generateServerCert, type ServerCert } from "../ca/serverCert";
import { logger } from "../logger";
import {
  INTERCEPT_DOMAINS,
  passthroughDomains,
  parseAuthority,
  resolveDestination,
  validateRequestDestination,
  type Destination,
} from "./policy";
import { logRequest, setResponseStatus } from "./requestLog";
import { getAccessToken } from "./token";

const CONNECT_DESTINATION = Symbol("validatedConnectDestination");
const CTX_LOG_ID = Symbol("logId");
export interface MitmProxy {
  handleSocket(socket: net.Socket): void;
  caCertPem: string;
  serverCert: ServerCert;
  close(): void;
}
export async function createMitmProxy(
  lanIp: string | null = null,
  checkAuth: (header: string) => boolean = () => false,
  publicHostname = "bore.pub",
  dependencies: {
    resolve?: typeof resolveDestination;
    token?: typeof getAccessToken;
    agent?: Agent;
  } = {},
): Promise<MitmProxy> {
  const allowedPassthrough = passthroughDomains();
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const sslCaDir = privateTempDir("claude-share-mitm-");
  const proxy = new Proxy();
  const deny = (ctx: any, status = 403) => {
    ctx.proxyToClientResponse.writeHead(status, {
      "Content-Type": "text/plain",
      Connection: "close",
    });
    ctx.proxyToClientResponse.end(
      status === 503
        ? "Sharer's OAuth token is unavailable or expired; sign in on the sharer and retry."
        : "Not allowed by claude-share policy",
    );
  };
  proxy.onError((_ctx, err) => logger.error("[mitm] proxy error", err));
  proxy.onRequest((ctx: any, callback) => {
    const connect = ctx.connectRequest;
    const destination: Destination | undefined = connect?.[CONNECT_DESTINATION];
    try {
      if (!destination || !checkAuth(connect.headers["proxy-authorization"] ?? ""))
        throw new Error("Missing authenticated CONNECT");
      validateRequestDestination(ctx, destination);
    } catch {
      deny(ctx);
      return;
    }
    let token: string;
    try {
      token = (dependencies.token ?? getAccessToken)();
    } catch {
      deny(ctx, 503);
      return;
    }
    const options = ctx.proxyToServerRequestOptions;
    // Numeric IP prevents a second DNS lookup; servername retains normal certificate validation.
    options.host = destination.address;
    options.hostname = destination.address;
    options.port = 443;
    options.family = destination.family;
    options.servername = destination.hostname;
    options.rejectUnauthorized = true;
    options.agent = dependencies.agent ?? false;
    options.headers.host = destination.hostname;
    options.headers.authorization = "Bearer " + token;
    for (const name of ["x-api-key", "x-forwarded-for", "x-real-ip", "proxy-authorization"])
      delete options.headers[name];
    ctx[CTX_LOG_ID] = logRequest(
      ctx.clientToProxyRequest.method ?? "GET",
      destination.hostname,
      ctx.clientToProxyRequest.url ?? "/",
      "allowed",
    );
    ctx.clientToProxyRequest.socket.once("close", () => ctx.proxyToServerRequest?.destroy());
    callback();
  });
  // Upgrades bypass onRequest in this dependency, so intercepted WebSockets fail closed.
  proxy.onWebSocketConnection((ctx, callback) => {
    ctx.clientToProxyWebSocket?.close(1008, "WebSocket interception is not supported");
    callback(new Error("WebSocket interception is not supported"));
  });
  proxy.onResponse((ctx: any, callback) => {
    if (ctx[CTX_LOG_ID] !== undefined)
      setResponseStatus(ctx[CTX_LOG_ID], ctx.serverToProxyResponse.statusCode ?? 0);
    for (const name of ["authorization", "set-cookie", "x-api-key", "anthropic-organization-id"])
      delete ctx.serverToProxyResponse.headers[name];
    callback();
  });
  proxy.onConnect((req: any, socket: any, head, callback) => {
    track(socket);
    const auth = req.headers["proxy-authorization"];
    if (typeof auth !== "string" || !checkAuth(auth)) {
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="claude-share"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    void (async () => {
      const { hostname } = parseAuthority(req.url ?? "");
      if (!INTERCEPT_DOMAINS.has(hostname) && !allowedPassthrough.has(hostname))
        throw new Error("Domain not approved");
      const destination = await (dependencies.resolve ?? resolveDestination)(hostname);
      if (socket.destroyed || !checkAuth(auth)) return socket.destroy();
      req[CONNECT_DESTINATION] = destination;
      if (INTERCEPT_DOMAINS.has(hostname)) return callback();
      const upstream = track(
        net.connect({ host: destination.address, port: 443, family: destination.family }, () => {
          socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
          if (head?.length) upstream.write(head);
          socket.pipe(upstream);
          upstream.pipe(socket);
        }),
      );
      upstream.setTimeout(120_000, () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      upstream.on("close", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      socket.on("error", () => upstream.destroy());
    })().catch(() =>
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
    );
  });
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    proxy.close();
    fs.rmSync(sslCaDir, { recursive: true, force: true });
  }
  try {
    await new Promise<void>((resolve, reject) =>
      proxy.listen({ port: 0, host: "127.0.0.1", sslCaDir, timeout: 120_000 }, (err) =>
        err ? reject(err) : resolve(),
      ),
    );
    const proxyPort = (proxy as any).httpServer.address().port as number;
    const caCertPem = fs.readFileSync(path.join(sslCaDir, "certs", "ca.pem"), "utf8");
    const caKeyPem = fs.readFileSync(path.join(sslCaDir, "keys", "ca.private.key"), "utf8");
    const serverCert = await generateServerCert(caCertPem, caKeyPem, lanIp, publicHostname);
    return {
      caCertPem,
      serverCert,
      close,
      handleSocket(socket) {
        if (closed) {
          socket.destroy();
          return;
        }
        track(socket);
        const upstream = track(net.connect(proxyPort, "127.0.0.1"));
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.on("error", () => upstream.destroy());
        upstream.on("error", () => socket.destroy());
        socket.on("close", () => upstream.destroy());
        upstream.on("close", () => socket.destroy());
      },
    };
  } catch (err) {
    try {
      close();
    } catch {
      /* Preserve the startup failure. */
    }
    throw err;
  }
}
