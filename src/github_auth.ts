// Signing in to GitHub from a page with no backend.
//
// The device flow is the only one that works here: it needs no client secret, so the only thing
// standing between the page and GitHub is a relay that adds the CORS headers GitHub's login
// endpoints omit. Everything after this talks to api.github.com directly, which does send them.

// import.meta.env is vite's, and node has no such thing, so the tests hand the same names in
// through globalThis rather than the module having to know it is being tested.
const env: Record<string, string | undefined> = (import.meta as any).env ?? (globalThis as any).VITE_ENV ?? {};
const CLIENT_ID = env.VITE_GH_CLIENT_ID;
const RELAY = env.VITE_GH_RELAY?.replace(/\/+$/, "");
const STORAGE = "xi-regions-github-token";

/** Whether sign-in is available at all, or the page has to fall back to a pasted token. */
export const canSignIn = () => !!CLIENT_ID && !!RELAY;

export interface DeviceCode {
  /** The eight characters the user types into github.com/login/device. */
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  /** Seconds between polls, as dictated by GitHub. */
  interval: number;
  expiresAt: number;
}

export interface StoredToken {
  token: string;
  login: string;
  scope: string;
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
  if (!res.ok) throw new Error(`relay ${path} → HTTP ${res.status}`);
  return res.json() as Promise<Record<string, string>>;
}

/**
 * Asks GitHub for a code to show the user. `scope` is deliberately narrow: public_repo can write to
 * public repositories and reach nothing private, which matters for a token that lives in a browser.
 */
export async function requestCode(scope = "public_repo"): Promise<DeviceCode> {
  if (!canSignIn()) throw new Error("sign-in is not configured");
  const out = await relay("/device/code", { client_id: CLIENT_ID!, scope });
  if (out.error) throw new Error(out.error_description || out.error);
  return {
    userCode: out.user_code,
    verificationUri: out.verification_uri,
    deviceCode: out.device_code,
    interval: Number(out.interval || 5),
    expiresAt: Date.now() + Number(out.expires_in || 900) * 1000,
  };
}

/**
 * Polls until the user finishes in the other tab. GitHub answers with an error while it waits, and
 * asks for a slower rhythm rather than refusing outright, so both are part of the normal path.
 */
export async function waitForToken(
  code: DeviceCode,
  opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; } = {},
): Promise<StoredToken> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  let wait = code.interval * 1000;

  while (Date.now() < code.expiresAt) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    await sleep(wait);

    const out = await relay("/device/token", {
      client_id: CLIENT_ID!,
      device_code: code.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    if (out.access_token) {
      const who = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${out.access_token}` },
      }).then(r => r.json());
      const stored: StoredToken = { token: out.access_token, login: who.login ?? "?", scope: out.scope ?? "" };
      localStorage.setItem(STORAGE, JSON.stringify(stored));
      return stored;
    }

    if (out.error === "authorization_pending") continue;
    if (out.error === "slow_down") {
      wait += 5000; // GitHub's own instruction, not a guess
      continue;
    }
    if (out.error === "device_flow_disabled") throw new Error("the OAuth app has device flow switched off");
    throw new Error(out.error_description || out.error || "sign-in failed");
  }

  throw new Error("the code expired, start again");
}
