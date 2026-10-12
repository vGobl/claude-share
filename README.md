# claude-share

Use a Linux machine to share Claude Code through an authenticated TLS proxy.
Receivers can run on macOS or native Windows (PowerShell or Command Prompt).

## Requirements

- Node.js **22.12+** (Node 22 and 24 are tested by CI).
- Claude Code installed on each receiver. The Linux sharer must have working Claude OAuth credentials from Claude's login.
- Bun **1.3.13** to install dependencies, develop, build, and run checks from this checkout. Installed packages run with Node.
- Optional: bore on the Linux sharer for internet sharing. LAN sharing works without it.

This checkout has not been published automatically. Build it locally to use these changes.

## Build this checkout

Install Node and Bun, then run from the repository root:

```text
bun install --frozen-lockfile
bun run build
```

Run the built files directly, or install this checkout locally with `npm install -g . --ignore-scripts`.
In PowerShell, use `npm.cmd` if execution policy blocks npm's PowerShell wrapper.

## Linux sharer

```sh
node dist/claude-share/index.js

# LAN only
TUNNEL=0 node dist/claude-share/index.js --port 2586
```

Choose a sharing duration and share the connect link displayed in the terminal.
Choose **Infinite (until stopped)** for sharing without an automatic time limit.
The sharer must stay running; stopping or restarting it ends the session, and a restart requires pairing again.
Unlimited sharing still requires valid OAuth credentials and enforces the same authentication and destination checks.
If a port is occupied, the sharer selects another port without killing its owner.
The port must be reachable from the receivers; for LAN access, allow the selected TCP port through the Linux firewall.

For internet sharing, the CLI asks before installing a missing bore binary on Linux.
The installer uses HTTPS GitHub downloads, limits redirects/time/size, and checks the release digest when GitHub supplies one. It does not silently run cargo or a package manager after a failed download.
You can install bore yourself instead. The public tunnel remains protected by the proxy's TLS and pairing/authentication.

## Windows receiver

Install Claude Code for native Windows using its [official setup instructions](https://code.claude.com/docs/en/setup).
Both a native Claude executable and an npm-installed Claude JavaScript entrypoint are supported.

From PowerShell or Command Prompt:

Open your project folder first; Claude works in the directory where you start the receiver.
For example, in PowerShell:

```powershell
Set-Location 'E:\Git Projects\claude-share'
```

```text
node dist/claude-connect/index.js --share "claudeshare://HOST:PORT/connect/CODE"

# Equivalent syntax
node dist/claude-connect/index.js --share="claudeshare://HOST:PORT/connect/CODE"

# Reconnect without the original pairing link
node dist/claude-connect/index.js

# Select a saved connection explicitly
node dist/claude-connect/index.js --reconnect
```

On macOS, use the same commands. If installed globally, replace the Node invocation with `claude-connect`.

Arguments such as `-p "your prompt"` are passed to Claude. Use `--` before arguments that would otherwise be interpreted as claude-connect flags.

## Receiver configuration and cleanup

Connections are saved under `~/.claude-share/connections/<machineId>.json`.
On Windows, `~` is your user profile directory.

Each saved connection has a separate Claude profile under `~/.claude-share/profiles/<machineId>`.
It retains shared-session history and settings. Onboarding and dummy credentials are confined to that profile; the receiver's normal Claude credentials and configuration are not rewritten. A child-only placeholder OAuth environment variable prevents macOS Keychain credentials from overriding that isolation.

Proxy and certificate variables apply only to the launched Claude process and its descendants. Conflicting inherited authentication/provider settings and proxy exclusions are removed.
A temporary CA file is deleted after normal exit, interruption, or a failed launch.
Nothing is installed into the system certificate store. A forced process termination or power loss can leave temporary files; the saved profile and connection are intentionally persistent.

Connection passwords are protected by private Unix permissions or user-specific Windows ACLs. Existing valid connections remain usable and have permissions tightened when loaded. Invalid entries produce recovery instructions; expired entries are removed automatically.

## Network and credential policy

Every CONNECT destination must use port 443, match an approved domain, and resolve only to public addresses. DNS results are pinned for each connection; localhost, private, link-local, documentation, multicast, and other reserved ranges are denied.

Token injection is limited to:

- `api.anthropic.com`: exact `/api/hello`, `POST /v1/messages`, `GET /v1/models`, `GET /api/claude_code/settings`, and `GET /api/claude_code/policy_limits` paths; query strings are permitted. The last two allow Claude to fetch the sharer's managed settings and organization policy. Other methods and subpaths on those policy endpoints are blocked.
- `platform.anthropic.com`: the existing `/api/auth/` route family.
- `platform.claude.com`: the existing `/v1/oauth/` route family.
- `mcp-proxy.anthropic.com`: the existing domain-wide MCP route family.

The authenticated CONNECT destination, request authority, upstream destination, and upstream TLS must agree before injecting the token.
Files, fine-tuning, assistants, and unlisted Anthropic API paths are blocked.
Intercepted WebSocket upgrades are rejected because the proxy dependency handles them outside the validated HTTP request path.
Forwarding policy requests does not enable other unlisted API routes or WebSockets; features requiring those remain unavailable through this proxy.

`raw.githubusercontent.com` is permitted as an opaque passthrough tunnel.
Additional domains can be enabled explicitly on the sharer:

```sh
PASSTHROUGH_DOMAINS=example.com,another.example.com node dist/claude-share/index.js
```

Entries must be exact domain names, without wildcards, URLs, or ports.
They never expand token-injection permissions or permit private network addresses.
Other domains are rejected through this proxy; that restriction does not sandbox the receiver's own network connection.

Pairing links contain the full encryption key. Keep them private and paste them into the CLI; only the five-character lookup prefix is sent during pairing. The encrypted response must match the receiver's connection identity and pairing origin.
Twenty failed pairing attempts globally within one minute temporarily block further attempts. Forwarded IP headers do not bypass this limit, and rotating a code does not reset it.

The sharer decrypts Claude traffic by design. Both parties must trust each other. OAuth tokens remain in sharer memory; expired tokens are not forwarded. The sharer rereads Linux credentials every minute and resumes when Claude has written valid credentials. Session expiry rejects new requests and closes existing tunnels.

## Runtime configuration

```sh
BORE_SERVER=bore.pub BORE_PASSWORD=your-secret node dist/claude-share/index.js
```

Bore configuration is read at runtime and is not embedded in builds.
If a previous published build contained a nonempty bore password, its owner must rotate that password.

Startup update checks only show a notice. Run `--upgrade` explicitly to install an update.

## Development and verification

```text
bun run dev:share
bun run dev:connect --share=<connect-url>
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:package
```

Tests use dummy credentials, local TLS fixtures, isolated profiles, and a fake Claude process.
Package checks install the generated tarball in an isolated consumer and load both CLI entrypoints.
Release CI gates publishing on Linux, macOS, and Windows checks using Node 22 and 24. Real-account Claude and real bore-service smoke tests are separate from these fixtures.
