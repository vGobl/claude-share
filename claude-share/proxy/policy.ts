import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export const INTERCEPT_DOMAINS = new Set([
  "api.anthropic.com",
  "platform.anthropic.com",
  "platform.claude.com",
  "mcp-proxy.anthropic.com",
]);

export function normalizeHostname(host: string): string {
  const value = host.toLowerCase();
  if (
    isIP(value) ||
    value.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
  ) {
    throw new Error("Invalid destination hostname");
  }
  return value;
}

export function passthroughDomains(value = process.env.PASSTHROUGH_DOMAINS ?? ""): Set<string> {
  return new Set([
    "raw.githubusercontent.com",
    ...value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(normalizeHostname),
  ]);
}

export function parseAuthority(authority: string): { hostname: string; port: 443 } {
  const match = /^([^:]+)(?::(443))?$/.exec(authority);
  if (!match) throw new Error("Only domain destinations on port 443 are allowed");
  return { hostname: normalizeHostname(match[1]), port: 443 };
}

const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, prefix, "ipv4");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("3fff::", 20, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export interface Destination {
  hostname: string;
  port: 443;
  address: string;
  family: 4 | 6;
}
export async function resolveDestination(
  hostname: string,
  resolve: (host: string) => Promise<Array<{ address: string; family: number }>> = (host) =>
    lookup(host, { all: true }),
): Promise<Destination> {
  hostname = normalizeHostname(hostname);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      resolve(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS lookup timed out")), 5000);
      }),
    ]);
    if (
      !addresses.length ||
      addresses.some((a) => !isPublicAddress(a.address) || isIP(a.address) !== a.family)
    ) {
      throw new Error("Destination resolves to a forbidden address");
    }
    const first = addresses.find((a) => a.family === 4) ?? addresses[0];
    return { hostname, port: 443, address: first.address, family: first.family as 4 | 6 };
  } finally {
    clearTimeout(timer);
  }
}

export function requestAllowed(host: string, method: string, target: string): boolean {
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    [...target].some((c) => c === "\\" || c.charCodeAt(0) <= 32)
  )
    return false;
  const rawPath = target.split("?")[0];
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  if (
    pathname.split("/").some((s) => s === "." || s === "..") ||
    [...pathname].some((c) => c === "\\" || c.charCodeAt(0) <= 32)
  )
    return false;
  if (host === "api.anthropic.com")
    return (
      pathname === "/api/hello" ||
      (pathname === "/v1/messages" && method === "POST") ||
      (method === "GET" &&
        (pathname === "/v1/models" ||
          pathname === "/api/claude_code/settings" ||
          pathname === "/api/claude_code/policy_limits"))
    );
  if (host === "platform.anthropic.com") return pathname.startsWith("/api/auth/");
  if (host === "platform.claude.com") return pathname.startsWith("/v1/oauth/");
  return host === "mcp-proxy.anthropic.com";
}

export function validateRequestDestination(
  ctx: {
    isSSL: boolean;
    clientToProxyRequest: { headers: { host?: string }; url?: string; method?: string };
    proxyToServerRequestOptions: { host?: string; hostname?: string; port?: number | string };
  },
  destination: Destination,
): void {
  const authority = parseAuthority(ctx.clientToProxyRequest.headers.host ?? "");
  const options = ctx.proxyToServerRequestOptions;
  if (
    !ctx.isSSL ||
    authority.hostname !== destination.hostname ||
    normalizeHostname(options.hostname ?? options.host ?? "") !== destination.hostname ||
    Number(options.port) !== 443 ||
    !requestAllowed(
      destination.hostname,
      ctx.clientToProxyRequest.method ?? "GET",
      ctx.clientToProxyRequest.url ?? "",
    )
  ) {
    throw new Error("Request does not match its authenticated TLS destination");
  }
}
