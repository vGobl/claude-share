import https from "node:https";
import { isIP } from "node:net";

export interface ApiFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  signal?: AbortSignal;
  ca?: string;
  rejectUnauthorized?: boolean;
}
export interface ApiFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export async function apiFetch(url: string, opts: ApiFetchOptions = {}): Promise<ApiFetchResponse> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("API requests require HTTPS without URL credentials");
  const {
    ca,
    rejectUnauthorized = true,
    timeout = 10_000,
    signal,
    method = "GET",
    headers = {},
    body,
  } = opts;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname.replace(/^\[|\]$/g, ""),
        port: Number(parsed.port || 443),
        path: parsed.pathname + parsed.search,
        method,
        headers,
        ca,
        rejectUnauthorized,
        servername: isIP(parsed.hostname.replace(/^\[|\]$/g, "")) ? undefined : parsed.hostname,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 512 * 1024) return req.destroy(new Error("API response too large"));
          chunks.push(chunk);
        });
        res.once("aborted", () => req.destroy(new Error("API response aborted")));
        res.once("error", reject);
        res.once("end", () => {
          const status = res.statusCode ?? 0;
          const data = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(data),
          });
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("Request timed out")), timeout);
    const abort = () => req.destroy(new Error("Aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    req.once("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
    req.once("error", reject);
    if (signal?.aborted) {
      abort();
      return;
    }
    if (body) req.write(body);
    req.end();
  });
}
