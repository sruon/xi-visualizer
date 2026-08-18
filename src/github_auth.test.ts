// node --experimental-strip-types src/github_auth.test.ts  (run by `pnpm test`)
//
// The device flow's normal path is a sequence of errors: GitHub answers authorization_pending until
// the user finishes in the other tab, and asks for a slower rhythm rather than refusing. Neither
// needs credentials to exercise, so both are checked here.
import assert from "node:assert";

// Set before the module under test is loaded, since it reads its configuration once.
(globalThis as any).VITE_ENV = { VITE_GH_CLIENT_ID: "client-123", VITE_GH_RELAY: "https://relay.test" };
(globalThis as any).localStorage = {
  store: new Map<string, string>(),
  getItem(k: string) {
    return this.store.get(k) ?? null;
  },
  setItem(k: string, v: string) {
    this.store.set(k, v);
  },
  removeItem(k: string) {
    this.store.delete(k);
  },
};

const { requestCode, waitForToken, storedToken, signOut, canSignIn } = await import("./github_auth.ts");

let replies: any[] = [];
const calls: { url: string; body: any; }[] = [];
(globalThis as any).fetch = async (url: string, init?: any) => {
  calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
  const next = replies.shift() ?? {};
  return { ok: true, status: 200, json: async () => next, text: async () => JSON.stringify(next) };
};

assert.ok(canSignIn(), "configured with a client id and a relay");

replies = [{ user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", device_code: "dev-1", interval: "5", expires_in: "900" }];
const code = await requestCode();
assert.strictEqual(code.userCode, "ABCD-1234");
assert.strictEqual(code.interval, 5, "the poll rhythm comes from GitHub, not from us");
assert.strictEqual(calls[0].body.client_id, "client-123");
assert.strictEqual(calls[0].body.scope, "public_repo", "narrow by default: nothing private is reachable");

// pending, then told to slow down, then the token
const waits: number[] = [];
replies = [
  { error: "authorization_pending" },
  { error: "slow_down" },
  { access_token: "gho_test", scope: "public_repo" },
  { login: "someone" },
];
const token = await waitForToken(code, { sleep: async ms => void waits.push(ms) });
assert.deepStrictEqual(waits, [5000, 5000, 10000], "slow_down adds the five seconds GitHub asks for");
assert.strictEqual(token.login, "someone", "the token is identified against the api before being kept");
assert.deepStrictEqual(storedToken(), { token: "gho_test", login: "someone", scope: "public_repo" }, "kept for next time");

signOut();
assert.strictEqual(storedToken(), null, "signing out forgets it");

// a code nobody ever typed in
replies = [{ error: "authorization_pending" }];
await assert.rejects(
  waitForToken({ ...code, expiresAt: Date.now() - 1 }, { sleep: async () => {} }),
  /expired/,
  "gives up once the code is dead rather than polling forever",
);

replies = [{ error: "device_flow_disabled" }];
await assert.rejects(waitForToken(code, { sleep: async () => {} }), /device flow/, "says which setting is wrong");

console.log("ok");
