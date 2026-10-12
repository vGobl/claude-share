const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const destination = args[args.indexOf("--output") + 1];
fs.writeFileSync(
  destination,
  JSON.stringify({
    args,
    profile: process.env.CLAUDE_CONFIG_DIR,
    proxy: process.env.HTTPS_PROXY,
    cert: process.env.NODE_EXTRA_CA_CERTS,
    certExists: fs.existsSync(process.env.NODE_EXTRA_CA_CERTS),
    auth: process.env.ANTHROPIC_AUTH_TOKEN,
    noProxy: process.env.NO_PROXY,
    placeholder: JSON.parse(
      fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "utf8"),
    ).claudeAiOauth.accessToken,
  }),
);
if (args.includes("--wait")) setInterval(() => {}, 1000);
else process.exit(Number(args[args.indexOf("--exit") + 1] || 0));
