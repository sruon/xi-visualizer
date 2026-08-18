// Minimal GitHub write path: commit files to a branch and open a PR, entirely from the browser.
// api.github.com is CORS-enabled, so this needs no backend — only a token the user supplies.

const API = "https://api.github.com";

async function gh(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export interface Proposal {
  token: string;
  repo: string;
  branch: string;
  base?: string;
  title: string;
  message: string;
  body?: string;
  files: { path: string; content: string; }[];
}

export interface ProposalResult {
  url: string;
  branch: string;
  /** The repository the commits went to, which is a fork when the user cannot push to the target. */
  wrote: string;
  /** True when the branch already existed and this pushed another commit onto it. */
  updated: boolean;
  /** True when the files already matched the branch, so nothing was committed. */
  unchanged: boolean;
}

/**
 * Commits `files` onto `branch` (creating it from the default branch if needed) and opens a pull
 * request, reusing an open one if there already is one. Uses the git data API so the whole thing is
 * five calls regardless of file count, with no base64 and no per-file blob SHAs.
 */
export async function propose(opts: Proposal): Promise<ProposalResult> {
  const { token, repo, branch, files } = opts;

  const upstream = await gh(token, `/repos/${repo}`);
  const base = opts.base || upstream.default_branch;
  const baseSha = (await gh(token, `/repos/${repo}/git/ref/heads/${base}`)).object.sha;

  // Anyone this is shared with is unlikely to have push access, which is the ordinary state of
  // affairs on someone else's repository rather than a problem: fork, commit there, and open the
  // pull request across. Forking is idempotent, so an existing fork comes straight back.
  const me = (await gh(token, "/user")).login as string;
  const canPush = !!upstream.permissions?.push;
  let target = repo;
  if (!canPush) {
    const fork = await gh(token, `/repos/${repo}/forks`, { method: "POST" });
    target = fork.full_name as string;
    // A fork is not queryable the instant it is asked for.
    for (let wait = 0; wait < 20; wait++) {
      try {
        await gh(token, `/repos/${target}/git/ref/heads/${fork.default_branch}`);
        break;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  const owner = target.split("/")[0];

  // The branch may survive from an earlier proposal for this zone; commit on top of it if so.
  let parentSha = baseSha;
  let existed = true;
  try {
    parentSha = (await gh(token, `/repos/${target}/git/ref/heads/${branch}`)).object.sha;
  } catch {
    existed = false;
  }

  const parent = await gh(token, `/repos/${target}/git/commits/${parentSha}`);
  const tree = await gh(token, `/repos/${target}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: parent.tree.sha,
      tree: files.map(f => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
    }),
  });

  // The branch lives on the fork, the pull request always belongs upstream.
  const head = canPush ? branch : `${me}:${branch}`;
  const openPr = async () => {
    const open = await gh(token, `/repos/${repo}/pulls?head=${owner}:${branch}&state=open`);
    if (open.length) return { url: open[0].html_url as string, branch, wrote: target, updated: true, unchanged: false };
    const pr = await gh(token, `/repos/${repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: opts.title, head, base, body: opts.body ?? "" }),
    });
    return { url: pr.html_url as string, branch, wrote: target, updated: existed, unchanged: false };
  };

  // Identical tree means there is nothing to commit — don't push an empty commit.
  if (tree.sha === parent.tree.sha) {
    return existed
      ? { ...(await openPr()), unchanged: true }
      : { url: `https://github.com/${repo}`, branch, wrote: target, updated: false, unchanged: true };
  }

  const commit = await gh(token, `/repos/${target}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: opts.message, tree: tree.sha, parents: [parentSha] }),
  });

  if (existed) {
    await gh(token, `/repos/${target}/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
  } else {
    await gh(token, `/repos/${target}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
  }

  return openPr();
}
