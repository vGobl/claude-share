import type { SharerAccount } from "@shared/types";

export type { ConnectionFile, SharerAccount } from "@shared/types";

export interface SavedConnection {
  id: string;
  systemName: string;
  lanServerUrl: string | null;
  publicServerUrl: string | null;
  sessionId: string;
  sharedUntil: string; // ISO-8601; UNLIMITED_SHARED_UNTIL keeps unlimited connections
  caPem: string;
  savedAt: string;
  sharerAccount: SharerAccount | null;
  proxyUser: string;
  proxyPass: string;
}

export interface ReceiverConfig {
  deviceName: string;
  hasConnectTermsAgreed?: boolean;
}
