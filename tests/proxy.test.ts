import assert from "node:assert/strict";
import { once } from "node:events";
import https from "node:https";
import net from "node:net";
import test from "node:test";
import tls from "node:tls";

import { sniffSocket } from "../claude-share/port/detector";
import { createMitmProxy } from "../claude-share/proxy/mitm";
import { certificates } from "./certificates";

function headers(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Response header timeout"));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", read);
      socket.removeListener("error", fail);
    };
    const fail = (err: Error) => {
      cleanup();
      reject(err);
    };
    const read = (chunk: Buffer) => {
      data += chunk.toString();
      if (data.includes("\r\n\r\n")) {
        cleanup();
        resolve(data);
      }
    };
    socket.on("data", read);
    socket.once("error", fail);
  });
}
test(
  "real nested TLS proxy streams only to the authenticated destination and never leaks a dummy token",
  { timeout: 30_000 },
  async () => {
    const fixture = certificates();
    let requests = 0;
    const upstream = https.createServer(fixture, (req, res) => {
      requests++;
      assert.equal(req.headers.authorization, "Bearer DUMMY_SHARER_TOKEN");
      assert.equal(req.headers["x-api-key"], undefined);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Set-Cookie": "secret=fixture" });
      res.write("data: first\n\n");
      setTimeout(() => res.end("data: second\n\n"), 20);
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    class FixtureAgent extends https.Agent {
      override createConnection(options: any) {
        return tls.connect({
          ...options,
          host: "127.0.0.1",
          port: upstreamPort,
          ca: fixture.caPem,
        });
      }
    }
    const agent = new FixtureAgent({ keepAlive: false });
    let active = true;
    let resolutions = 0;
    const proxy = await createMitmProxy(
      null,
      (auth) => active && auth === "Basic fixture",
      "localhost",
      {
        resolve: async (hostname) => {
          resolutions++;
          return { hostname, port: 443, address: "8.8.8.8", family: 4 };
        },
        token: () => "DUMMY_SHARER_TOKEN",
        agent,
      },
    );
    const sockets = new Set<net.Socket>();
    const outer = tls.createServer(
      { cert: proxy.serverCert.certPem, key: proxy.serverCert.keyPem },
      (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        const deny = (s: net.Socket) => s.end("HTTP/1.1 426 Upgrade Required\r\n\r\n");
        sniffSocket(
          socket,
          { onConnect: (s) => proxy.handleSocket(s), onHttp: deny, onTls: deny },
          false,
        );
      },
    );
    outer.listen(0, "127.0.0.1");
    await once(outer, "listening");
    const port = (outer.address() as net.AddressInfo).port;
    async function connect(authority = "api.anthropic.com:443", auth = "Basic fixture") {
      const socket = tls.connect({
        host: "127.0.0.1",
        port,
        ca: proxy.caCertPem,
        servername: "localhost",
      });
      socket.on("error", () => {});
      await once(socket, "secureConnect");
      const response = headers(socket);
      socket.write("CON");
      await new Promise((resolve) => setTimeout(resolve, 5));
      socket.write(
        "NECT " +
          authority +
          " HTTP/1.1\r\nHost: " +
          authority +
          "\r\nProxy-Authorization: " +
          auth +
          "\r\n\r\n",
      );
      return { socket, response: await response };
    }
    async function exchange(target: string, host = "api.anthropic.com", innerTls = true) {
      const { socket, response } = await connect();
      assert.match(response, /200/);
      const transport = innerTls
        ? tls.connect({ socket, servername: "api.anthropic.com", ca: proxy.caCertPem })
        : socket;
      transport.on("error", () => {});
      if (innerTls) await once(transport, "secureConnect");
      let data = "";
      transport.on("data", (chunk) => (data += chunk.toString()));
      transport.setTimeout(5000, () => transport.destroy(new Error("Exchange timeout")));
      const ended = once(transport, "close");
      transport.write(
        "POST " +
          target +
          " HTTP/1.1\r\nHost: " +
          host +
          "\r\nX-Api-Key: RECEIVER_KEY\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
      );
      await ended;
      socket.destroy();
      return data;
    }
    try {
      const good = await exchange("/v1/messages");
      assert.match(good, /200/);
      assert.match(good, /data: first/);
      assert.match(good, /data: second/);
      assert.doesNotMatch(good, /set-cookie/i);
      assert.equal(requests, 1);
      for (const [target, host, tlsEnabled] of [
        ["http://evil.example/v1/messages", "api.anthropic.com", true],
        ["/v1/messages", "evil.example", true],
        ["/v1/messages", "api.anthropic.com", false],
        ["/v1/files", "api.anthropic.com", true],
      ] as const)
        assert.match(await exchange(target, host, tlsEnabled), /403/);
      assert.equal(requests, 1, "No denied request reached an upstream");
      assert.equal(resolutions, 5, "Each tunnel resolves once; requests do not re-resolve DNS");
      for (const authority of ["evil.example:443", "api.anthropic.com:80", "127.0.0.1:443"]) {
        const result = await connect(authority);
        assert.match(result.response, /403/);
        result.socket.destroy();
      }
      const badAuth = await connect("api.anthropic.com:443", "Basic bad");
      assert.match(badAuth.response, /407/);
      badAuth.socket.destroy();
      active = false;
      const expired = await connect();
      assert.match(expired.response, /407/);
      expired.socket.destroy();
      assert.equal(requests, 1);
    } finally {
      proxy.close();
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      outer.close();
      upstream.closeAllConnections();
      upstream.close();
    }
  },
);
