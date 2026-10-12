import { X509Certificate } from "node:crypto";

import type { ConnectionFile } from "./types";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 256): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error(`Invalid ${label}`);
  return value;
}
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value))
    throw new Error("Invalid machine/session ID");
  return value;
}
export function serverUrl(value: unknown): string {
  const input = text(value, "server URL", 2048);
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !url.hostname
  )
    throw new Error("Server URL must be an HTTPS origin without credentials");
  return url.origin;
}
export function isoDate(value: unknown): string {
  const input = text(value, "date", 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input) ||
    !Number.isFinite(Date.parse(input))
  )
    throw new Error("Invalid date");
  const [year, month, day] = input.slice(0, 10).split("-").map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  )
    throw new Error("Invalid calendar date");
  return input;
}
export function validateConnection(value: unknown): ConnectionFile {
  const v = record(value);
  const lanServerUrl = v.lanServerUrl === null ? null : serverUrl(v.lanServerUrl);
  const publicServerUrl = v.publicServerUrl === null ? null : serverUrl(v.publicServerUrl);
  if (!lanServerUrl && !publicServerUrl) throw new Error("Connection has no server URL");
  const caPem = validateCa(v.caPem);
  return {
    lanServerUrl,
    publicServerUrl,
    sessionId: uuid(v.sessionId),
    sharedUntil: isoDate(v.sharedUntil),
    caPem,
    systemName: text(v.systemName, "system name"),
    proxyUser: uuid(v.proxyUser),
    proxyPass: validatePassword(v.proxyPass),
    sharerAccount: validateAccount(v.sharerAccount),
  };
}
function validatePassword(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/i.test(value))
    throw new Error("Invalid proxy password");
  return value;
}
function validateAccount(value: unknown): ConnectionFile["sharerAccount"] {
  if (value === null || value === undefined) return null;
  const v = record(value);
  const field = (x: unknown) => (x === "" ? "" : text(x, "account", 256));
  return {
    emailAddress: field(v.emailAddress),
    displayName: field(v.displayName),
    organizationName: field(v.organizationName),
  };
}
export function validateCa(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 64 * 1024 ||
    !value.startsWith("-----BEGIN CERTIFICATE-----")
  )
    throw new Error("Invalid CA certificate");
  const cert = new X509Certificate(value);
  if (!cert.ca || Date.parse(cert.validTo) <= Date.now())
    throw new Error("Invalid or expired CA certificate");
  return value;
}
