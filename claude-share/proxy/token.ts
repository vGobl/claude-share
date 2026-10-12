import { platform, type OAuthCredentials } from "@shared/platforms";

import { logger } from "../logger";
let cached: OAuthCredentials | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let generation = 0;
export async function initToken(configDir?: string) {
  stopTokenRefresh();
  const current = generation;
  cached = await platform().readOAuthCredentials(configDir);
  refreshTimer = setInterval(() => {
    void platform()
      .readOAuthCredentials(configDir)
      .then((creds) => {
        if (current === generation) cached = creds;
      })
      .catch((err) => logger.error("[token] credential re-read failed", err));
  }, 60_000);
  refreshTimer.unref();
}
export function getAccessToken() {
  if (!cached || !cached.accessToken || cached.expiresAt <= Date.now())
    throw new Error("Sharer OAuth token unavailable or expired");
  return cached.accessToken;
}
export function getSubscriptionType() {
  return cached?.subscriptionType ?? "unknown";
}
export function stopTokenRefresh() {
  generation++;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  cached = null;
}
