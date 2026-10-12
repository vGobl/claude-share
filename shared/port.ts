export function parsePort(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    throw new Error("Port must be an integer from 1 to 65535");
  return Number(value);
}
