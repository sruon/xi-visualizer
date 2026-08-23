// pnpm relay:secrets
//
// Uploads the relay's three secrets from .dev.vars, which is gitignored and already what `pnpm
// relay` reads locally. This exists instead of three `wrangler secret put` prompts because that
// prompt says only "Enter a secret value" -- it never names the key it is asking for, so getting
// the client id and the client secret the wrong way round is easy and invisible afterwards.
// Secrets cannot be read back, so a swap is only discovered later as an auth failure.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NEEDED = ["GH_CLIENT_ID", "GH_CLIENT_SECRET", "ALLOWED_LOGINS"];
const SOURCE = new URL("../.dev.vars", import.meta.url);

let text;
try {
  text = readFileSync(SOURCE, "utf8");
} catch {
  console.error("No .dev.vars. Copy .dev.vars.example to .dev.vars and fill it in.");
  process.exit(1);
}

const vars = Object.fromEntries(
  text.split("\n")
    .filter(line => line.trim() && !line.trimStart().startsWith("#"))
    .map(line => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const missing = NEEDED.filter(name => !vars[name]);
if (missing.length) {
  console.error(`.dev.vars is missing: ${missing.join(", ")}`);
  process.exit(1);
}

// The mistake this script exists to prevent. A GitHub App client id has a known shape and a client
// secret does not, so a swap is detectable rather than something to find out about in a month.
if (!vars.GH_CLIENT_ID.startsWith("Iv23li")) {
  console.error(`GH_CLIENT_ID is "${vars.GH_CLIENT_ID.slice(0, 8)}…", which is not a GitHub App client id (they start Iv23li).`);
  console.error("Have the id and the secret been swapped?");
  process.exit(1);
}
if (vars.GH_CLIENT_SECRET.startsWith("Iv23li")) {
  console.error("GH_CLIENT_SECRET looks like a client id. Have the two been swapped?");
  process.exit(1);
}

// wrangler takes a JSON file rather than arguments, which keeps the values out of the process list
// and the shell history. It lives in a temp directory for as long as the upload takes.
const dir = mkdtempSync(join(tmpdir(), "relay-secrets-"));
const file = join(dir, "secrets.json");
try {
  writeFileSync(file, JSON.stringify(Object.fromEntries(NEEDED.map(n => [n, vars[n]]))), { mode: 0o600 });
  console.log(`Uploading ${NEEDED.join(", ")} to the github-relay worker…`);
  execFileSync("npx", ["wrangler@4", "secret", "bulk", file, "-c", "workers/wrangler.toml"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
