// A CORS relay for GitHub's device flow, and nothing else.
//
// github.com/login/* sends no CORS headers, so a page cannot complete the token exchange itself.
// api.github.com does, so everything after sign-in talks to GitHub directly and never comes here.
// There is no client secret: the device flow does not use one, so this holds no credential at all
// and is safe to run anywhere.
//
// Deploy (Cloudflare Workers free tier):
//   npx wrangler deploy workers/github-relay.js --name github-relay --compatibility-date 2026-01-01
// then set VITE_GH_RELAY to the deployed URL and VITE_GH_CLIENT_ID to the OAuth app's client id.
// The OAuth app needs "Device flow" ticked in its settings, or GitHub answers device_flow_disabled.

const ALLOWED = [
  "http://localhost:5173",
  "http://localhost:5199",
  "https://sruon.github.io",
];

const ENDPOINTS = {
  "/device/code": "https://github.com/login/device/code",
  "/device/token": "https://github.com/login/oauth/access_token",
};

const cors = origin => ({
  "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[ALLOWED.length - 1],
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
});

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") ?? "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

    const target = ENDPOINTS[new URL(request.url).pathname];
    if (!target || request.method !== "POST") {
      return new Response("not found", { status: 404, headers: cors(origin) });
    }

    // Forwarded as-is. The body carries a client id and a device code, both of which are public.
    const upstream = await fetch(target, {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: await request.text(),
    });

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  },
};
