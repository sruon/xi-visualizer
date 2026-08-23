// ALLOWED_LOGINS=you GH_CLIENT_ID=Iv23li… GH_CLIENT_SECRET=… pnpm relay
//
// Runs workers/github-relay.js locally. A Worker is a module exporting `fetch(Request, env)`, and
// node has had Request and Response for years, so this is a socket and an adapter rather than a
// second implementation: the file under test is the file that deploys.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import worker from "../workers/github-relay.js";

const PORT = Number(process.env.PORT || 8787);

// .dev.vars is wrangler's own convention for local secrets, so one gitignored file serves both this
// and `wrangler dev`. The client secret must never reach .env.local: vite inlines VITE_* into the
// public bundle, which is right for the client id and catastrophic for the secret.
function devVars() {
  try {
    return Object.fromEntries(
      readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
        .split("\n")
        .filter(line => line.trim() && !line.trimStart().startsWith("#"))
        .map(line => {
          const at = line.indexOf("=");
          return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, "")];
        }),
    );
  } catch {
    return {};
  }
}

const file = devVars();
const pick = name => process.env[name] ?? file[name] ?? "";
const env = {
  ALLOWED_LOGINS: pick("ALLOWED_LOGINS"),
  GH_CLIENT_ID: pick("GH_CLIENT_ID"),
  GH_CLIENT_SECRET: pick("GH_CLIENT_SECRET"),
};

const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) console.warn(`! ${missing.join(", ")} not set, so sign-in will refuse. Put them in .dev.vars, see docs/github-sign-in.md.`);

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  // node hands back arrays for headers that may repeat; Request wants plain strings.
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
  );

  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
  });

  try {
    const out = await worker.fetch(request, env);
    const body = Buffer.from(await out.arrayBuffer());
    console.log(`${req.method} ${req.url} → ${out.status}`);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(body);
  } catch (e) {
    console.error(`${req.method} ${req.url} → ${e}`);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`${e}`);
  }
}).listen(PORT, () => {
  console.log(`relay on http://localhost:${PORT}, allowing: ${env.ALLOWED_LOGINS || "(nobody)"}`);
});
