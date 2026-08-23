// Everything the editor writes goes to one branch on the user's own fork of LSB.
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
  const name = upstream.split("/")[1];
  const repo = `${login}/${name}`;
  const mine = await ghMaybe(token, `/repos/${repo}`);
  if (!(mine?.fork && mine.parent?.full_name === upstream)) return { state: "missing" };
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

export interface SaveRequest {
  token: string;
  /** The fork, owner/name. */
  repo: string;
  /** Long-lived working branch. Commits pile up on it until a pull request is opened by hand. */
  branch: string;
  /** Branch in the fork the working branch is cut from, and the one a pull request targets. */
  base: string;
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
}

/**
 * Commits `files` onto the working branch, creating it from a freshly synced base the first time.
 *
 * Uses the git data API, so this is a handful of calls regardless of how many files change, with no
 * base64 and no per-file blob SHAs.
 */
export async function save(req: SaveRequest): Promise<SaveResult> {
  const { token, repo, branch, base, files } = req;

  let head = (await ghMaybe(token, `/repos/${repo}/git/ref/heads/${branch}`))?.object?.sha as string | undefined;
  const created = !head;

  if (!head) {
    // A fork left alone for a month is a month behind, and a branch cut from it starts every review
    // with unrelated changes. Syncing can fail when the fork has commits of its own on base, which
    // is the user's business to sort out, not a reason to refuse to save.
    await gh(token, `/repos/${repo}/merge-upstream`, { method: "POST", body: JSON.stringify({ branch: base }) })
      .catch(() => {});
    head = (await gh(token, `/repos/${repo}/git/ref/heads/${base}`)).object.sha;
  }

  const parent = await gh(token, `/repos/${repo}/git/commits/${head}`);
  const tree = await gh(token, `/repos/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: parent.tree.sha,
      tree: files.map(f => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
    }),
  });

  if (tree.sha === parent.tree.sha) return { unchanged: true, created: false, onBranch: !created };

  const commit = await gh(token, `/repos/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: req.message, tree: tree.sha, parents: [head] }),
  });

  if (created) {
    await gh(token, `/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
  } else {
    await gh(token, `/repos/${repo}/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
  }

  return { sha: commit.sha, unchanged: false, created, onBranch: true };
}
