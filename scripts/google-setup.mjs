// Guided setup for the two Google values. Checks each one's shape before
// saving, so a wrong paste is caught here instead of at Google's sign-in page.
// Run: npm run google:setup
import { spawnSync } from "node:child_process";
import readline from "node:readline";

const DRY = process.env.DRY_RUN === "1";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let muted = false;
const write = rl._writeToOutput.bind(rl);
rl._writeToOutput = (s) => {
  if (!muted) write(s);
};

const lines = [];
let waiting = null;
rl.on("line", (l) => (waiting ? waiting(l) : lines.push(l)));
rl.on("close", () => waiting && (console.error("\nInput ended before setup finished."), process.exit(1)));

function ask(question, hidden) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const done = (answer) => {
      waiting = null;
      if (hidden) {
        muted = false;
        process.stdout.write("\n");
      }
      resolve(answer.trim());
    };
    if (lines.length) return done(lines.shift());
    muted = hidden; // hide what is typed for the secret
    waiting = done;
  });
}

async function askUntil(label, where, check, hint, hidden) {
  console.log(`\n${label}\n  Where: ${where}`);
  for (;;) {
    const v = await ask("  Paste it here, then press Enter: ", hidden);
    if (check(v)) return v;
    console.log(`  ✗ That is not it. ${hint}\n  Copy it from the Google page, then come back and paste again.`);
  }
}

function save(name, value) {
  if (DRY) return console.log(`  (dry run) would save ${name}`);
  const r = spawnSync("npx", ["wrangler", "secret", "put", name], { input: value, stdio: ["pipe", "inherit", "inherit"] });
  if (r.status !== 0) {
    console.error(`\n✗ Could not save ${name}. Send this error to Claude.`);
    process.exit(1);
  }
}

console.log("Santino · Google setup\nOpen the Santino client in Google Cloud (Google Auth Platform → Clients → Santino).");

const id = await askUntil(
  "1 of 2 · Client ID",
  'the long value ending in ".apps.googleusercontent.com"',
  (v) => /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(v),
  'A Client ID ends in ".apps.googleusercontent.com".',
  false,
);
const secret = await askUntil(
  "2 of 2 · Client secret",
  'the short value starting with "GOCSPX-" (use "Add secret" if it is hidden)',
  (v) => /^GOCSPX-[A-Za-z0-9_-]{20,}$/.test(v),
  'A Client secret starts with "GOCSPX-". It will not show as you paste.',
  true,
);

rl.close();
console.log("\nSaving to Cloudflare…");
save("GOOGLE_CLIENT_ID", id);
save("GOOGLE_CLIENT_SECRET", secret);
console.log("\n✓ Both saved. Tell Claude: done");
