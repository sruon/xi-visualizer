// node src/github.test.ts  (run by `pnpm test`)
//
// The write path has branches that only show themselves against a real repository: the first save
// cuts a branch, later ones move it, and an unchanged tree must not become an empty commit. A fake
// GitHub is enough to hold all three honest.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { compareUrl, fillTemplate, findFork, prTitle, save } from "./github.ts";

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

const UPSTREAM = "sruon/server";
const FORK = "someone/server";

// --- finding the fork ---

// The staging repo is itself a fork, so every check is against the network root rather than a parent.
const NETWORK = "LandSandBoat/server";
const upstreamIs = { "/repos/sruon/server": { full_name: UPSTREAM, source: { full_name: NETWORK } } };
const forkExists = { ...upstreamIs, "/repos/someone/server": { fork: true, source: { full_name: NETWORK } } };
const installedFor = (full_name: string) => ({
  "/user/installations": { installations: [{ id: 7 }] },
  "/user/installations/7/repositories?per_page=100": { repositories: [{ full_name }] },
});
const installedHere = installedFor(FORK);

fakeGitHub({ ...forkExists, ...installedHere });
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone"), { state: "ready", repo: FORK });

// A repo of the same name that is not a fork of ours is not ours to write to.
fakeGitHub({ ...upstreamIs, "/repos/someone/server": { fork: true, source: { full_name: "someone-else/thing" } } });
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone"), { state: "missing" }, "a repo outside the network is not ours to write to");

// The maintainer's own fork is the staging repo itself, and has to be accepted like any other.
fakeGitHub({ ...upstreamIs, "/repos/sruon/server": { full_name: UPSTREAM, source: { full_name: NETWORK } }, ...installedFor("sruon/server") });
assert.deepStrictEqual(await findFork("t", UPSTREAM, "sruon"), { state: "ready", repo: "sruon/server" });

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

const ZONE = "west_ronfaure";
const SITTING = "regions/2026-08-23";
const files = [{ path: `data/zones/${ZONE}/regions.yaml`, content: "regions:\n" }];
const saving = { token: "t", repo: FORK, baseRepo: UPSTREAM, branch: SITTING, base: "regions-master" };
const thisZone = { zone: ZONE, message: `${ZONE}: 3 regions, 42 spawns`, files };

// The staging tip is read on every save, so it belongs to every case.
const nth = (calls, suffix) => calls.filter(c => c.method === "POST" && c.path.endsWith(suffix)).length;
const commonRoutes = {
  "/repos/sruon/server/git/ref/heads/regions-master": { object: { sha: "base-sha" } },
  "/repos/someone/server/git/commits/base-sha": { tree: { sha: "tree-old" } },
  "/repos/someone/server/git/commits/commit-1": { tree: { sha: "tree-1" } },
  "/repos/someone/server/git/commits/commit-2": { tree: { sha: "tree-2" } },
  // Each replayed zone builds on the one before, so a fake that answered with one sha forever
  // would make every commit after the first look like a no-op.
  "POST /repos/someone/server/git/trees": calls => ({ sha: `tree-${nth(calls, "/git/trees")}` }),
  "POST /repos/someone/server/git/commits": calls => ({ sha: `commit-${nth(calls, "/git/commits")}` }),
  "POST /repos/someone/server/git/refs": {},
};
const branchAt = sha => ({ [`/repos/someone/server/git/ref/heads/${SITTING}`]: { object: { sha } } });

// first save of a sitting: the branch is cut straight from the staging tip
let calls = fakeGitHub({ ...commonRoutes });
let result = await save({ ...saving, ...thisZone });
assert.deepStrictEqual(result, { sha: "commit-1", unchanged: false, created: true, onBranch: true, zones: [ZONE] });
assert.ok(
  calls.some(c => c.path === "/repos/sruon/server/git/ref/heads/regions-master"),
  "cut from the staging branch itself, which forks in a network can point a ref at",
);
assert.ok(!calls.some(c => c.path.endsWith("/merge-upstream")), "so there is nothing to sync");
assert.ok(calls.some(c => c.method === "POST" && c.path.endsWith("/git/refs")), "created the branch");

// A second zone in the same sitting: the first one is replayed from its existing blob, so the
// branch ends up carrying one commit each rather than a commit per save.
calls = fakeGitHub({
  ...commonRoutes,
  ...branchAt("branch-sha"),
  [`PATCH /repos/someone/server/git/refs/heads/${SITTING}`]: {},
  "/repos/someone/server/compare/base-sha...branch-sha": {
    commits: [{ commit: { message: "east_ronfaure: 1 region, 8 spawns" } }],
    files: [{ filename: "data/zones/east_ronfaure/regions.yaml", sha: "blob-east", status: "modified" }],
  },
});
result = await save({ ...saving, ...thisZone });
assert.deepStrictEqual(result.zones, ["east_ronfaure", ZONE], "both zones are on the branch, in a stable order");
const commits = calls.filter(c => c.method === "POST" && c.path.endsWith("/git/commits"));
assert.strictEqual(commits.length, 2, "one commit per zone, not one per save");
assert.deepStrictEqual(
  commits.map(c => c.body.message),
  ["east_ronfaure: 1 region, 8 spawns", `${ZONE}: 3 regions, 42 spawns`],
  "each zone keeps its own message, in a stable order",
);
const trees = calls.filter(c => c.method === "POST" && c.path.endsWith("/git/trees"));
assert.strictEqual(trees[0].body.tree[0].sha, "blob-east", "the untouched zone is replayed by blob, not re-uploaded");
assert.strictEqual(trees[1].body.tree[0].content, "regions:\n", "and the saved zone by its new content");
assert.ok(calls.some(c => c.method === "PATCH" && c.body.force === true), "the rewrite has to be forced");

// Re-saving a zone whose content already matches must not rewrite the branch at all: replaying
// would mint new commit hashes every time, since a commit takes in when it was made.
// git's real hash for the fixture, so the short-circuit is exercised rather than assumed
const sameBlob = "32cb00a14923d6708072e2291c6d1afce217022c";
calls = fakeGitHub({
  ...commonRoutes,
  ...branchAt("branch-sha"),
  "/repos/someone/server/compare/base-sha...branch-sha": {
    commits: [{ commit: { message: `${ZONE}: 3 regions, 42 spawns` } }],
    files: [{ filename: `data/zones/${ZONE}/regions.yaml`, sha: sameBlob, status: "modified" }],
  },
});
result = await save({ ...saving, ...thisZone });
assert.deepStrictEqual(result, { unchanged: true, created: false, onBranch: true, zones: [ZONE] });
assert.ok(!calls.some(c => c.method === "PATCH" || c.path.endsWith("/git/commits") && c.method === "POST"), "nothing was rewritten");

// Work already merged into the staging branch compares away, so the sitting starts over instead of
// dragging the merged commits along behind it.
calls = fakeGitHub({
  ...commonRoutes,
  ...branchAt("branch-sha"),
  [`PATCH /repos/someone/server/git/refs/heads/${SITTING}`]: {},
  "/repos/someone/server/compare/base-sha...branch-sha": { commits: [], files: [] },
});
result = await save({ ...saving, ...thisZone });
assert.deepStrictEqual(result.zones, [ZONE], "only the zone being saved is left");

// nothing to commit and no branch either: no pull request to offer, which is what onBranch says
calls = fakeGitHub({ ...commonRoutes, "POST /repos/someone/server/git/trees": { sha: "tree-old" } });
result = await save({ ...saving, ...thisZone });
assert.deepStrictEqual(result, { unchanged: true, created: false, onBranch: false, zones: [] });

// A refusal has to arrive naming the permission and the way out, since "Resource not accessible by
// integration" is what GitHub says when an installation is still on the permissions it was made with.
fakeGitHub({
  ...commonRoutes,
  "POST /repos/someone/server/git/trees": {
    $status: 403,
    $headers: { get: h => (h === "x-accepted-github-permissions" ? "contents=write" : null) },
    $body: '{"message":"Resource not accessible by integration"}',
  },
});
await assert.rejects(
  save({ ...saving, ...thisZone }),
  /does not grant contents=write/s,
  "the error names the permission and where to grant it",
);

// --- the pull request title ---

assert.strictEqual(prTitle([ZONE]), "[yaml] Roam regions for west_ronfaure");
assert.strictEqual(prTitle(["a", "b", "c"]), "[yaml] Roam regions for a, b, c", "a few are worth naming");
assert.strictEqual(prTitle(["a", "b", "c", "d"]), "[yaml] Roam regions for 4 zones", "more than a few are worth counting");
assert.strictEqual(prTitle([]), "[yaml] Roam regions for several zones", "and nothing known is not an empty title");

// --- the pull request body ---

// The template is a file so the wording can be edited without touching code; the cost is that a
// placeholder can be misspelled there, and a silently empty pull request body is the worst way to
// find out. Unknown names survive intact so the mistake is visible in the pull request itself.
assert.strictEqual(
  fillTemplate("drawn with {{editor}} against `{{base}}`", { editor: "the editor", base: "base" }),
  "drawn with the editor against `base`",
);
assert.strictEqual(fillTemplate("{{ zone }} and {{zone}}", { zone: "west_ronfaure" }), "west_ronfaure and west_ronfaure", "spacing inside the braces does not matter");
assert.strictEqual(fillTemplate("{{typo}} here", { zone: "x" }), "{{typo}} here", "an unknown name is left alone, not blanked");
assert.strictEqual(fillTemplate("nothing to fill", {}), "nothing to fill");

// and the template that actually ships has to be fillable by what the editor passes it
const template = readFileSync(new URL("./pr_template.md", import.meta.url), "utf8");
const filled = fillTemplate(template, {
  editor: "E", zone: "Z", base: "B", diff: "D", regions: "1", spawns: "2",
});
assert.doesNotMatch(filled, /\{\{/, `pr_template.md has a placeholder nothing fills: ${filled.match(/\{\{\w+\}\}/g)}`);
// Deliberately not asserting which placeholders the template uses: the prose is the maintainer's
// to edit, and dropping one is a valid edit. What must hold is that whatever it does use is fed.

console.log("ok");
