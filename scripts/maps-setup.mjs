// Saves the Google Maps key after checking it looks like one, so a wrong paste
// is caught here. Run: npm run maps:setup
import { spawnSync } from "node:child_process";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
// Buffer lines so a fast paste (or piped input) is never lost between prompts.
const lines = []; let waiting = null;
rl.on("line", (l) => (waiting ? waiting(l) : lines.push(l)));
rl.on("close", () => { if (waiting) { console.error("\nInput ended before a key was entered."); process.exit(1); } });
const ask = (q) => new Promise((r) => {
  process.stdout.write(q);
  const done = (a) => { waiting = null; r(a.trim()); };
  if (lines.length) done(lines.shift()); else waiting = done;
});

console.log("Santino · Google Maps key\n  Where: Google Cloud → APIs & Services → Credentials → your Santino Maps key (starts with \"AIza\")");
let key = "";
for (;;) {
  key = await ask("  Paste the key, then press Enter: ");
  if (/^AIza[0-9A-Za-z_-]{35}$/.test(key)) break;
  console.log('  ✗ That is not a Maps key. It starts with "AIza" and is 39 characters. Copy it again and paste.');
}
rl.close();
if (process.env.DRY_RUN === "1") { console.log("  (dry run) would save GOOGLE_MAPS_KEY"); process.exit(0); }
const r = spawnSync("npx", ["wrangler", "secret", "put", "GOOGLE_MAPS_KEY"], { input: key, stdio: ["pipe", "inherit", "inherit"] });
if (r.status !== 0) { console.error("\n✗ Could not save it. Send this error to Claude."); process.exit(1); }
console.log("\n✓ Saved. Tell Claude: done");
