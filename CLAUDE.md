# claude-share

Single npm package exposing two Node CLIs. Source entrypoints are claude-share/index.ts and claude-connect/index.ts; Bun builds them into dist/<command>/index.js with runtime dependencies external.

## Development

Use Bun 1.3.13 and Node 22.12+.
Run bun install --frozen-lockfile, bun run lint, bun run typecheck, bun run test, bun run build, and bun run test:package.
Set TUNNEL=0 to skip bore during development. PowerShell: $env:TUNNEL="0".

## Supported target

Linux sharer, macOS and native Windows receivers. Keep Windows command arguments out of shell strings: resolve native executables or npm package bin entrypoints and invoke JavaScript with Node.

## Security invariants

- Only a five-character pairing prefix crosses the network. The full pairing code is a 32-byte Base58 encryption key.
- Pairing failures use a global bounded 20-per-minute limiter, independent of forwarded headers and code rotation.
- Authenticate every request against session expiry and bind session mutations to the authenticated machine.
- Infinite sharing uses the reserved ISO date in shared/sharing-expiry.ts and skips the shutdown timer; timed sessions still expire normally. Session state remains in memory.
- CONNECT destinations require approved domains, port 443, public addresses, and pinned DNS resolution.
- Before injection, request authority, authenticated CONNECT destination, upstream target and TLS must agree.
- Additional PASSTHROUGH_DOMAINS never expand token-injection permissions. Preserve existing auth/MCP route families documented in README.
- Intercepted WebSocket upgrades fail closed because the dependency bypasses HTTP request hooks.
- Expired OAuth tokens are never forwarded. Reread Linux credentials every minute; do not invent an OAuth refresh protocol.
- Never bake bore configuration or secrets into bundles.
- Receiver profiles are isolated using CLAUDE_CONFIG_DIR. Do not write normal Claude configuration or credentials.
- Saved secrets use atomic writes and restrictive ACLs/permissions. CA trust applies only to the child process.
- Do not kill arbitrary processes to reclaim a port or install updates during ordinary startup.

## Tests and release

Regression tests run with Node against Bun-built test files. Dependencies injected into the MITM constructor exist for local fixtures; production uses the DNS validator, normal certificate verification, and the real token getter.
Checks cover nested TLS, streaming, forbidden routing, pairing, ownership, expiry, literal Windows arguments, isolated profiles and cleanup.
The release workflow requires the six-platform/runtime matrix. Do not publish as part of a local implementation task.
