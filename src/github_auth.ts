// Installing the app and signing in, in one trip to github.com.
//
// A GitHub App has two separate grants and the editor needs both: authorization says who you are,
// installation is what lets a token write to a repository. The device flow only ever does the
// first, which is why it was the wrong flow here -- it produces a token that reads your fork
// perfectly and refuses every commit. Ticking "Request user authorization (OAuth) during
// installation" on the app collapses both into one redirect, and that is what this drives.
//
// The exchange needs the client secret, so unlike the device flow the relay does hold a credential
// now. PKCE is not accepted on the installation entry point, so `state` is what ties the redirect
// back to the tab that started it. Everything after sign-in talks to api.github.com directly.

// import.meta.env is vite's, and node has no such thing, so the tests hand the same names in
// through globalThis rather than the module having to know it is being tested.
const env: Record<string, string | undefined> = (import.meta as any).env ?? (globalThis as any).VITE_ENV ?? {};
const CLIENT_ID = env.VITE_GH_CLIENT_ID;
const RELAY = env.VITE_GH_RELAY?.replace(/\/+$/, "");
const APP_SLUG = env.VITE_GH_APP_SLUG;
const STORAGE = "xi-regions-github-token";
const PENDING = "xi-regions-oauth-pending";

/** Whether this build was pointed at an app and a relay. Without all three there is no way in. */
export const canSignIn = () => !!CLIENT_ID && !!RELAY && !!APP_SLUG;

export interface StoredToken {
  token: string;
  login: string;
}

export function storedToken(): StoredToken | null {
  try {
    const raw = localStorage.getItem(STORAGE);
    return raw ? JSON.parse(raw) as StoredToken : null;
  } catch {
    return null;
  }
}

export function signOut() {
  localStorage.removeItem(STORAGE);
}

async function relay(path: string, body: Record<string, string>) {
  const res = await fetch(`${RELAY}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
  });
  // A refusal carries its reason in the body, and that reason is the useful half.
  const out = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok && !out.error) throw new Error(`relay ${path} → HTTP ${res.status}`);
  return out;
}

interface Pending {
  state: string;
  /** The hash route to come back to: the callback lands on the site root with no hash of its own. */
  returnTo: string;
}

function readPending(): Pending | null {
  try {
    return JSON.parse(sessionStorage.getItem(PENDING) ?? "null");
  } catch {
    return null;
  }
}

/**
 * Sends the user off to install the app. They choose the repositories, and because authorization is
 * requested during installation GitHub comes back to the callback URL carrying a code as well.
 */
export function startInstall(returnTo: string) {
  if (!canSignIn()) throw new Error("sign-in is not configured");
  const state = crypto.randomUUID();
  sessionStorage.setItem(PENDING, JSON.stringify({ state, returnTo } satisfies Pending));
  location.href = `https://github.com/apps/${APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`;
}

/** Whether the current URL is GitHub bringing somebody back from an installation. */
export const isCallback = () => new URLSearchParams(location.search).has("code");

/**
 * The callback lands on the site root, which under a hash router is the home page and not the
 * editor somebody left from. Called before the router mounts, this puts the route back.
 */
export function restoreRoute() {
  if (!isCallback() || location.hash) return;
  location.hash = readPending()?.returnTo || "#/regions";
}

/** Verifies the redirect belongs to this tab, exchanges the code, and keeps the token. */
export async function completeInstall(): Promise<StoredToken> {
  const query = new URLSearchParams(location.search);
  const code = query.get("code");
  const pending = readPending();
  sessionStorage.removeItem(PENDING); // single use, whatever happens next

  // Without this, somebody can hand a contributor a callback URL of their own making and have the
  // editor quietly adopt an account nobody chose.
  if (!pending || pending.state !== query.get("state")) {
    throw new Error("this sign-in did not start in this tab, so it was not completed");
  }
  if (!code) {
    throw new Error("GitHub sent no code: tick 'Request user authorization (OAuth) during installation' on the app");
  }

  const out = await relay("/oauth/token", { code });
  if (out.error) throw new Error(out.error_description || out.error);
  if (!out.access_token) throw new Error("the relay returned no token");

  // The relay had to identify the account to check it against the list, and passes the answer
  // along, so there is no reason to ask GitHub the same question again.
  const stored: StoredToken = { token: out.access_token, login: out.login ?? "?" };
  localStorage.setItem(STORAGE, JSON.stringify(stored));
  return stored;
}
