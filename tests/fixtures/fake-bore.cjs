const fs = require("node:fs");
fs.writeFileSync(process.env.CLAUDE_SHARE_TEST_BORE_OUTPUT, JSON.stringify(process.argv.slice(2)));
process.stdout.write("listening at localhost:123");
setTimeout(() => process.stdout.write("45\n"), 20);
setInterval(() => {}, 1000);
