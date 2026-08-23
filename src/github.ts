// Everything the editor writes goes to one branch on the contributor's own fork, holding one
// commit per zone, and a pull request from there into the staging repository.
//
// api.github.com sends CORS headers, so all of this runs from the browser with the user's token and
// needs no backend. Two steps are deliberately missing: forking the upstream repository and opening
// the pull request. A GitHub App cannot do either -- both require it to be installed on the account
// that owns the upstream repository, which is not ours to install on -- so those are links the user
// clicks on github.com, and everything in between is done here.

const API = "https://api.github.com";

async function gh(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if (res.ok) return res.json();

  const where = `${init?.method ?? "GET"} ${path}`;
  // On a refusal GitHub names the permission the call wanted. "Resource not accessible by
  // integration" on its own is a puzzle; with the permission named it is an instruction, and the
  // usual cause is an installation still on the permissions it was created with.
  const needs = res.headers?.get?.("x-accepted-github-permissions");
  const error: any = new Error(
    res.status === 403 && needs
      ? `${where} → 403. The app installation does not grant ${needs}. Accept the app's pending `
        + `permission request at github.com/settings/installations, then sign out and in again.`
      : `${where} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`,
  );
  error.status = res.status;
  throw error;
}

/** Same, but a 404 is an answer rather than a failure. */
async function ghMaybe(token: string, path: string) {
  try {
    return await gh(token, path);
  } catch (e) {
    if ((e as { status?: number; }).status === 404) return null;
    throw e;
  }
}

export async function whoAmI(token: string): Promise<string> {
  return (await gh(token, "/user")).login;
}

export type ForkState =
  /** Ready to write to. */
  | { state: "ready"; repo: string; }
  /** No fork yet, so there is nothing to install onto either. */
  | { state: "missing"; }
  /** The fork is there and the app is authorized, but it was never installed on the repository. */
  | { state: "not_installed"; repo: string; };

/** Where the app gets installed on a repository. Signing in does not do this and cannot. */
export const installUrl = (slug: string) => `https://github.com/apps/${slug}/installations/new`;

/**
 * Whether this app is installed on `repo` for the signed-in user.
 *
 * Asked because reading proves nothing: a user access token may read any public repository whether
 * or not the app was ever installed on it, so a fork reads back perfectly and then refuses the
 * first write. This is the question the write path actually depends on.
 */
async function installedOn(token: string, repo: string): Promise<boolean> {
  const { installations } = await gh(token, "/user/installations");
  for (const installation of installations ?? []) {
    const { repositories } = await gh(token, `/user/installations/${installation.id}/repositories?per_page=100`);
    if (repositories?.some((r: any) => r.full_name === repo)) return true;
  }
  return false;
}

/**
 * Finds the user's fork of `upstream`, and whether it can actually be written to.
 *
 * Both halves matter and they fail differently: no fork at all means go and make one, while a fork
 * without an installation means go and install the app on it. Neither is something the app can do
 * on the user's behalf.
 */
export async function findFork(token: string, upstream: string, login: string): Promise<ForkState> {
  // Membership is of the fork *network*, not of one parent. Contributors fork LandSandBoat/server
  // while pull requests target a fork of it, so an immediate-parent test would reject every
  // legitimate fork. Everything in one network shares an object store, which is also what lets a
  // branch be cut straight from a sibling fork further down.
  const target = await gh(token, `/repos/${upstream}`);
  const network = target.source?.full_name ?? target.full_name;

  const repo = `${login}/${upstream.split("/")[1]}`;
  const mine = await ghMaybe(token, `/repos/${repo}`);
  const sameNetwork = mine && (mine.source?.full_name ?? mine.full_name) === network;
  if (!sameNetwork) return { state: "missing" };

  return (await installedOn(token, repo)) ? { state: "ready", repo } : { state: "not_installed", repo };
}

/** github.com's own fork page. One click, and it is the only way an app can get a fork made. */
export const forkUrl = (upstream: string) => `https://github.com/${upstream}/fork`;

/**
 * GitHub's pull request form, comparing the working branch against upstream. `quick_pull=1` is the
 * documented way to open it ready to submit, and `title` and `body` can be appended to prefill it.
 */
export const compareUrl = (upstream: string, base: string, repo: string, branch: string) =>
  `https://github.com/${upstream}/compare/${base}...${repo.replace("/", ":")}:${branch}?quick_pull=1`;

/**
 * Fills `{{name}}` placeholders. A name with nothing to put in it is left as it was rather than
 * blanked, so a typo in the template shows up in the pull request instead of quietly vanishing.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name) => vars[name] ?? whole);
}

export interface SaveRequest {
  token: string;
  /** The fork, owner/name. Commits land here. */
  repo: string;
  /** Where `base` lives: the repository pull requests are opened against. */
  baseRepo: string;
  /** The sitting's working branch. It carries one commit per zone touched, and is rebuilt on
   * every save so that stays true. */
  branch: string;
  /** Branch in `baseRepo` the working branch is cut from, and the one a pull request targets. */
  base: string;
  /** The zone being saved. Its commit is the one replaced on the branch. */
  zone: string;
  message: string;
  files: { path: string; content: string; }[];
}

export interface SaveResult {
  /** The commit, absent when the files already matched the branch. */
  sha?: string;
  unchanged: boolean;
  /** True the first time, when the branch was cut and the fork brought up to date first. */
  created: boolean;
  /** Whether the branch exists now. False when there was nothing to commit and no branch yet, which
   * is the one case where offering a pull request link would lead to an empty compare page. */
  onBranch: boolean;
  /** How many zones the branch now carries, which is also how many commits it has. */
  zones: number;
}

/** One zone's contribution to the branch: the files it changes, and why. */
interface ZoneWork {
  message: string;
  /** Either a blob already in the repository, or new content to be written. */
  entries: { path: string; sha?: string; content?: string; }[];
}

/**
 * Git's own hash for a file's contents, computed here so an unchanged zone can be recognised
 * without uploading anything. Rebuilding the branch is otherwise indistinguishable from changing
 * it: commit hashes take in the time they were made, so a replay always produces new ones.
 */
async function blobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${body.length}${String.fromCharCode(0)}`);
  const buffer = new Uint8Array(header.length + body.length);
  buffer.set(header);
  buffer.set(body, header.length);
  const digest = await crypto.subtle.digest("SHA-1", buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** The zone a path under data/zones/<zone>/ belongs to, or null for anything else. */
function zoneOfPath(path: string): string | null {
  const parts = path.split("/");
  return parts[0] === "data" && parts[1] === "zones" && parts.length > 3 ? parts[2] : null;
}

/**
 * Puts this zone on the working branch, as exactly one commit.
 *
 * The branch is rebuilt from the staging tip on every save rather than appended to: each zone
 * already on it is replayed as a single commit, this zone's is replaced, and the ref is moved to
 * the result. That is what keeps "one commit per zone" true no matter how many times a zone is
 * saved, and it means a branch whose work has since been merged quietly starts over rather than
 * carrying the merged commits around.
 */
export async function save(req: SaveRequest): Promise<SaveResult> {
  const { token, repo, baseRepo, branch, base, zone, files } = req;

  // Forks in a network share objects, so this fork can point a ref straight at the staging tip
  // without being synced first -- and a branch cut this way is never behind.
  const baseSha = (await gh(token, `/repos/${baseRepo}/git/ref/heads/${base}`)).object.sha as string;
  const head = (await ghMaybe(token, `/repos/${repo}/git/ref/heads/${branch}`))?.object?.sha as string | undefined;

  // What the branch already carries, per zone. Comparing against the *current* staging tip is what
  // makes merged work disappear from this set on its own.
  const work = new Map<string, ZoneWork>();
  if (head && head !== baseSha) {
    const diff = await gh(token, `/repos/${repo}/compare/${baseSha}...${head}`);
    const messages = new Map<string, string>();
    for (const entry of diff.commits ?? []) {
      const message = String(entry.commit?.message ?? "");
      const named = message.split(":")[0].trim();
      if (named) messages.set(named, message);
    }
    for (const file of diff.files ?? []) {
      const name = zoneOfPath(file.filename);
      if (!name || file.status === "removed") continue;
      const found = work.get(name) ?? { message: messages.get(name) ?? `${name}: regions`, entries: [] };
      found.entries.push({ path: file.filename, sha: file.sha });
      work.set(name, found);
    }
  }

  // Saving a zone that already matches what is on the branch must not rewrite anything.
  const already = work.get(zone);
  if (already) {
    const wanted = await Promise.all(files.map(async f => `${f.path}@${await blobSha(f.content)}`));
    const have = already.entries.map(e => `${e.path}@${e.sha}`);
    if (wanted.sort().join() === have.sort().join()) return { unchanged: true, created: false, onBranch: true, zones: work.size };
  }

  work.set(zone, { message: req.message, entries: files.map(f => ({ path: f.path, content: f.content })) });

  // Replay: one commit per zone, in a stable order so the branch reads the same way every time.
  let parent = baseSha;
  for (const name of [...work.keys()].sort()) {
    const { message, entries } = work.get(name)!;
    const parentCommit = await gh(token, `/repos/${repo}/git/commits/${parent}`);
    const tree = await gh(token, `/repos/${repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: parentCommit.tree.sha,
        tree: entries.map(e => ({
          path: e.path,
          mode: "100644",
          type: "blob",
          ...(e.sha ? { sha: e.sha } : { content: e.content }),
        })),
      }),
    });
    if (tree.sha === parentCommit.tree.sha) continue; // this zone matches the staging branch already
    parent = (await gh(token, `/repos/${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message, tree: tree.sha, parents: [parent] }),
    })).sha;
  }

  if (parent === baseSha) return { unchanged: true, created: false, onBranch: !!head, zones: 0 };

  if (head) {
    // Force, because replaying rewrote what was there. It is a working branch and this is its point.
    await gh(token, `/repos/${repo}/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: parent, force: true }),
    });
  } else {
    await gh(token, `/repos/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: parent }),
    });
  }

  return { sha: parent, unchanged: false, created: !head, onBranch: true, zones: work.size };
}
