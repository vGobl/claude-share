// Keep sharedUntil as an ISO date for compatibility with existing receivers.
// This reserved value represents sharing with no automatic expiry.
export const UNLIMITED_SHARED_UNTIL = "9999-12-31T23:59:59.999Z";

export function isUnlimitedSharing(sharedUntil: Date): boolean {
  return sharedUntil.getTime() === Date.parse(UNLIMITED_SHARED_UNTIL);
}
