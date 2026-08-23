// node src/github_auth.test.ts  (run by `pnpm test`)
//
// The install flow leaves the page and comes back, and everything that can go wrong goes wrong on
// the way back: a redirect that did not start here, a redirect carrying no code because the app was
// misconfigured, and a route that has to be restored because the callback lands on the site root.
import assert from "node:assert";

// Set before the module under test is loaded, since it reads its configuration once.
(globalThis as any).VITE_ENV = {
  VITE_GH_CLIENT_ID: "Iv23liTEST",
  VITE_GH_RELAY: "https://relay.test",
  VITE_GH_APP_SLUG: "lsb-roam-regions-editor",
};

const store = (map = new Map<string, string>()) => ({
  getItem: (k: string) => map.get(k) ?? null,
  setItem: (k: string, v: string) => void map.set(k, v),
  removeItem: (k: string) => void map.delete(k),
});
(globalThis as any).localStorage = store();
(globalThis as any).sessionStorage = store();

/** Stands in for the address bar. */
let href = "";
(globalThis as any).location = {
  search: "",
  hash: "",
  pathname: "/xi-visualizer/",
  set href(v: string) {
    href = v;
  },
};

const { canSignIn, completeInstall, isCallback, restoreRoute, signOut, startInstall, storedToken } = await import(
  "./github_auth.ts"
);

let reply: any = {};
const calls: { url: string; body: any; }[] = [];
(globalThis as any).fetch = async (url: string, init?: any) => {
  calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
  return { ok: !reply.error, status: reply.error ? 403 : 200, json: async () => reply };
};

assert.ok(canSignIn(), "configured with a client id, a relay and a slug");

// --- leaving ---

startInstall("#/regions/west_ronfaure");
assert.match(
  href,
  /^https:\/\/github\.com\/apps\/lsb-roam-regions-editor\/installations\/new\?state=/,
  "goes to install, which authorizes on the way, rather than to authorize alone",
);
/** The nonce the module just issued, which is the only thing a valid callback can carry. */
const issued = () => JSON.parse(sessionStorage.getItem("xi-regions-oauth-pending")!).state as string;
assert.ok(href.includes(`state=${encodeURIComponent(issued())}`), "carries the nonce tying the trip back to this tab");

// --- coming back ---

const location = (globalThis as any).location;
location.search = `?code=abc&installation_id=42&setup_action=install&state=${issued()}`;
assert.ok(isCallback(), "a code in the query is what a callback looks like");

// the callback lands on the site root, so the route the user left from has to be put back
location.hash = "";
restoreRoute();
assert.strictEqual(location.hash, "#/regions/west_ronfaure", "back where they were, not the home page");

reply = { access_token: "ghu_test", login: "someone" };
const token = await completeInstall();
assert.deepStrictEqual(token, { token: "ghu_test", login: "someone" });
assert.strictEqual(calls[0].body.code, "abc", "the code went to the relay");
assert.ok(!("client_secret" in calls[0].body), "the secret is the relay's business, not the page's");
assert.deepStrictEqual(storedToken(), { token: "ghu_test", login: "someone" }, "kept for next time");

signOut();
assert.strictEqual(storedToken(), null, "signing out forgets it");

// --- the ways back that must not be trusted ---

// a callback nobody started here: the pending state was consumed above, so nothing matches it
location.search = "?code=abc&state=whatever";
await assert.rejects(completeInstall(), /did not start in this tab/, "an unsolicited callback is refused");

// a state that does not match the one we issued
startInstall("#/regions");
location.search = "?code=abc&state=somebody-elses";
await assert.rejects(completeInstall(), /did not start in this tab/, "a forged state is refused");

// installed, but the app never asks for authorization, so there is no code to exchange
startInstall("#/regions");
location.search = `?installation_id=42&setup_action=install&state=${issued()}`;
await assert.rejects(completeInstall(), /Request user authorization/, "says which setting is missing");

// the relay refusing somebody has to reach the user rather than vanish into a generic failure
startInstall("#/regions");
location.search = `?code=abc&state=${issued()}`;
reply = { error: "not_allowed", error_description: "nobody is not on this editor's list." };
await assert.rejects(completeInstall(), /not on this editor's list/, "says why it was refused");

// a spent code cannot be replayed by reloading, since the pending state is consumed either way
startInstall("#/regions");
location.search = `?code=abc&state=${issued()}`;
reply = { access_token: "ghu_x", login: "someone" };
await completeInstall();
await assert.rejects(completeInstall(), /did not start in this tab/, "the pending state is single use");

console.log("ok");
