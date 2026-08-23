// node src/github.test.ts  (run by `pnpm test`)
//
// The write path has branches that only show themselves against a real repository: the first save
// cuts a branch, later ones move it, and an unchanged tree must not become an empty commit. A fake
// GitHub is enough to hold all three honest.
import assert from "node:assert";
import { compareUrl, findFork, save } from "./github.ts";

const noHeaders = { get: () => null };

interface Call {
  method: string;
  path: string;
  body?: any;
}

/** Answers by method and path; anything unlisted is a 404, which is a real answer here. */
function fakeGitHub(routes: Record<string, any>) {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init?: any) => {
    const path = url.replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
    // An entry may be keyed with or without the method, and may be a function of the request.
    const hit = routes[`${method} ${path}`] ?? routes[path];
    const value = typeof hit === "function" ? hit(calls) : hit;
    if (value === undefined) return { ok: false, status: 404, headers: noHeaders, text: async () => "no such thing" };
    if (value?.$status) {
      return { ok: false, status: value.$status, headers: value.$headers ?? noHeaders, text: async () => value.$body ?? "" };
    }
    return { ok: true, status: 200, headers: noHeaders, json: async () => value, text: async () => JSON.stringify(value) };
  };
  return calls;
}

const UPSTREAM = "LandSandBoat/server";
const FORK = "someone/server";

// --- finding the fork ---

const forkExists = { "/repos/someone/server": { fork: true, parent: { full_name: UPSTREAM } } };
const installedHere = {
  "/user/installations": { installations: [{ id: 7 }] },
  "/user/installations/7/repositories?per_page=100": { repositories: [{ full_name: FORK }] },
};

fakeGitHub({ ...forkExists, ...installedHere });
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone"), { state: "ready", repo: FORK });

// A repo of the same name that is not a fork of ours is not ours to write to.
fakeGitHub({ "/repos/someone/server": { fork: false } });
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone"), { state: "missing" });

// Authorised but never installed. The token reads the public fork without trouble, so reading is
// not the question: this is the case that used to report "ready" and then 403 on the first write.
fakeGitHub({ ...forkExists, "/user/installations": { installations: [] } });
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone"), { state: "not_installed", repo: FORK });

// Installed, but on some other repository of theirs.
fakeGitHub({
  ...forkExists,
  "/user/installations": { installations: [{ id: 7 }] },
  "/user/installations/7/repositories?per_page=100": { repositories: [{ full_name: "someone/notes" }] },
});
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone"), { state: "not_installed", repo: FORK });

// --- saving ---

const files = [{ path: "data/zones/west_ronfaure/regions.yaml", content: "regions:\n" }];
const commonRoutes = {
  "/repos/someone/server/git/commits/base-sha": { tree: { sha: "tree-old" } },
  "POST /repos/someone/server/git/trees": { sha: "tree-new" },
  "POST /repos/someone/server/git/commits": { sha: "commit-1" },
  "POST /repos/someone/server/merge-upstream": { merge_type: "fast-forward" },
  "POST /repos/someone/server/git/refs": {},
};

// first save: the fork is brought up to date, the branch is cut, the commit lands on it
let calls = fakeGitHub({
  ...commonRoutes,
  "/repos/someone/server/git/ref/heads/base": { object: { sha: "base-sha" } },
});
let result = await save({ token: "t", repo: FORK, branch: "xi-regions", base: "base", message: "m", files });
assert.deepStrictEqual(result, { sha: "commit-1", unchanged: false, created: true, onBranch: true });
assert.ok(calls.some(c => c.path.endsWith("/merge-upstream")), "synced the fork before cutting from it");
assert.ok(calls.some(c => c.method === "POST" && c.path.endsWith("/git/refs")), "created the branch");
assert.ok(!calls.some(c => c.method === "PATCH"), "nothing to move yet");

// second save: the branch is already there, so it is moved and the fork is left alone
calls = fakeGitHub({
  ...commonRoutes,
  "/repos/someone/server/git/ref/heads/xi-regions": { object: { sha: "base-sha" } },
  "PATCH /repos/someone/server/git/refs/heads/xi-regions": {},
});
result = await save({ token: "t", repo: FORK, branch: "xi-regions", base: "base", message: "m", files });
assert.deepStrictEqual(result, { sha: "commit-1", unchanged: false, created: false, onBranch: true });
assert.ok(calls.some(c => c.method === "PATCH" && c.path.endsWith("/git/refs/heads/xi-regions")), "moved the branch");
assert.ok(!calls.some(c => c.path.endsWith("/merge-upstream")), "an existing branch is not resynced under the user");

// saving the same content twice must not pile up empty commits
calls = fakeGitHub({
  ...commonRoutes,
  "/repos/someone/server/git/ref/heads/xi-regions": { object: { sha: "base-sha" } },
  "POST /repos/someone/server/git/trees": { sha: "tree-old" }, // identical to the parent's
});
result = await save({ token: "t", repo: FORK, branch: "xi-regions", base: "base", message: "m", files });
assert.deepStrictEqual(result, { unchanged: true, created: false, onBranch: true });
assert.ok(!calls.some(c => c.path.endsWith("/git/commits") && c.method === "POST"), "no commit was made");

// nothing to commit and no branch either: there is no pull request to offer, and saying so is the
// whole point of onBranch
calls = fakeGitHub({
  ...commonRoutes,
  "/repos/someone/server/git/ref/heads/base": { object: { sha: "base-sha" } },
  "POST /repos/someone/server/git/trees": { sha: "tree-old" },
});
result = await save({ token: "t", repo: FORK, branch: "xi-regions", base: "base", message: "m", files });
assert.deepStrictEqual(result, { unchanged: true, created: false, onBranch: false });

// a fork that cannot be synced (commits of its own on base) still gets the save
calls = fakeGitHub({
  ...commonRoutes,
  "POST /repos/someone/server/merge-upstream": undefined, // 409 in real life
  "/repos/someone/server/git/ref/heads/base": { object: { sha: "base-sha" } },
});
result = await save({ token: "t", repo: FORK, branch: "xi-regions", base: "base", message: "m", files });
assert.strictEqual(result.sha, "commit-1", "a fork that would not sync is not a reason to lose the work");

// A refusal has to arrive naming the permission and the way out, since "Resource not accessible by
// integration" is what GitHub says when an installation is still on the permissions it was made with.
fakeGitHub({
  "/repos/someone/server/git/ref/heads/xi-regions": { object: { sha: "base-sha" } },
  "/repos/someone/server/git/commits/base-sha": { tree: { sha: "tree-old" } },
  "POST /repos/someone/server/git/trees": {
    $status: 403,
    $headers: { get: (h: string) => (h === "x-accepted-github-permissions" ? "contents=write" : null) },
    $body: '{"message":"Resource not accessible by integration"}',
  },
});
await assert.rejects(
  save({ token: "t", repo: FORK, branch: "xi-regions", base: "base", message: "m", files }),
  /does not grant contents=write.*settings\/installations/s,
  "the error names the permission and where to grant it",
);

// --- the pull request link ---

const url = compareUrl(UPSTREAM, "base", FORK, "xi-regions");
assert.strictEqual(url, "https://github.com/LandSandBoat/server/compare/base...someone:server:xi-regions?quick_pull=1");
assert.ok(url.includes("?quick_pull=1"), "title and body can be appended to it with &");

console.log("ok");
