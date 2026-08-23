// The only server the regions editor has: it turns an installation's code into a token, and holds
// the list of people allowed to use the editor.
//
// It exists because github.com/login/oauth/access_token sends no CORS headers and requires the
// client secret, which a static page can hold neither of. api.github.com does send CORS headers, so
// everything after sign-in goes straight from the browser to GitHub and never comes back here.
//
// What the allowlist is: a gate on who gets to use this editor. It is not a boundary around LSB --
// nobody can push to base with or without it, and anyone can fork and open a pull request by hand.
// It exists so the sign-in button is not an open door, and that is all it needs to do.
//
// Deploy (Cloudflare Workers free tier):
//   npx wrangler deploy workers/github-relay.js --name github-relay --compatibility-date 2026-01-01
//   npx wrangler secret put GH_CLIENT_SECRET    # from the app's settings page
//   npx wrangler secret put ALLOWED_LOGINS      # e.g. sruon,someone,someone-else
//   npx wrangler secret put GH_CLIENT_ID        # Iv23li…, public, a secret only for convenience
// The app needs "Request user authorization (OAuth) during installation" ticked and a callback URL
// for every origin below, or GitHub comes back without a code.

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5199",
  "https://sruon.github.io",
];

const TOKEN_URL = "https://github.com/login/oauth/access_token";

const cors = origin => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
});

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });

/** Who the token belongs to, asked of GitHub rather than taken from the page. */
async function loginOf(accessToken) {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "xi-visualizer-relay",
    },
  });
  return res.ok ? (await res.json()).login : null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";
    // A browser will not read a response it was not given permission for, so an unlisted origin is
    // refused outright rather than answered with somebody else's.
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response("origin not allowed", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

    const path = new URL(request.url).pathname;
    if (path !== "/oauth/token" || request.method !== "POST") return json({ error: "not_found" }, 404, origin);
    if (!env.GH_CLIENT_SECRET || !env.GH_CLIENT_ID) return json({ error: "relay_misconfigured" }, 500, origin);

    const { code } = await request.json().catch(() => ({}));
    if (!code) return json({ error: "no_code" }, 400, origin);

    // The one thing the page cannot do itself: the secret goes in here and never leaves.
    const upstream = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: env.GH_CLIENT_ID, client_secret: env.GH_CLIENT_SECRET, code }),
    });
    const body = await upstream.json().catch(() => ({}));

    // The one decision this relay makes. GitHub has already established who the user is by the time
    // a token exists, so this is a name lookup rather than a trust decision of our own.
    if (body.access_token) {
      const allowed = (env.ALLOWED_LOGINS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
      const login = await loginOf(body.access_token);
      if (!login || !allowed.includes(login.toLowerCase())) {
        return json({
          error: "not_allowed",
          error_description: login
            ? `${login} is not on this editor's list. Ask to be added, or fork LSB and edit the yaml by hand.`
            : "could not identify the account behind this token",
        }, 403, origin);
      }
      body.login = login; // saves the page a round trip to ask the same question
    }

    return json(body, upstream.status, origin);
  },
};
