import { createSignal, Show, onMount } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import LookupInput, { Option } from "../components/lookup_input";
import NavMeshCompareViewer from "../components/navmesh_compare_viewer";

// Fetch a .nav straight from GitHub's raw host (CORS-enabled). Raw always reflects the
// ref's current commit, so branch links stay live; a ref may also be a tag or commit SHA.
// (jsDelivr was avoided here: it negative-caches 404s and serves ~12h-stale branch content.)
const rawUrl = (repo: string, ref: string, zone: string) =>
  `https://raw.githubusercontent.com/${repo}/${ref}/${encodeURIComponent(zone)}.nav`;

// List the .nav zone names in a ref via GitHub's tree API (CORS-enabled). Cached per
// repo@ref so switching zones doesn't re-hit the 60/hr unauthenticated rate limit.
const zoneListCache = new Map<string, string[]>();
const listZones = async (repo: string, ref: string): Promise<string[]> => {
  const key = `${repo}@${ref}`;
  const cached = zoneListCache.get(key);
  if (cached) {
    return cached;
  }

  const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${ref}`);
  if (!res.ok) {
    throw new Error(`zone list for ${ref} → HTTP ${res.status}`);
  }

  const json = (await res.json()) as { tree?: { path: string }[] };
  const zones = (json.tree ?? [])
    .map(e => e.path)
    .filter(p => p.endsWith(".nav"))
    .map(p => p.slice(0, -4))
    .sort((a, b) => a.localeCompare(b));
  zoneListCache.set(key, zones);
  return zones;
};

const DEFAULT_REPO = "sruon/xiNavmeshes";

export default function NavMeshDiffPage() {
  const [params, setParams] = useSearchParams();

  // repoA/repoB are independent, but both fall back to a shared `repo` param (and default),
  // so same-repo links stay compact and cross-repo links carry both.
  const [repoA, setRepoA] = createSignal((params.repoA as string) || (params.repo as string) || DEFAULT_REPO);
  const [repoB, setRepoB] = createSignal((params.repoB as string) || (params.repo as string) || DEFAULT_REPO);
  const [refA, setRefA] = createSignal((params.a as string) || "base");
  const [refB, setRefB] = createSignal((params.b as string) || "navmesh_offmesh_links");
  const [zone, setZone] = createSignal((params.zone as string) || "");

  const [navA, setNavA] = createSignal<ArrayBuffer | undefined>();
  const [navB, setNavB] = createSignal<ArrayBuffer | undefined>();
  const [labelA, setLabelA] = createSignal("");
  const [labelB, setLabelB] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();
  const [copied, setCopied] = createSignal(false);
  // Bumped on each successful load so the keyed <Show> remounts the viewer cleanly.
  const [token, setToken] = createSignal(0);

  const [zones, setZones] = createSignal<string[]>([]);
  const [zonesMsg, setZonesMsg] = createSignal("");

  const sameRepo = () => repoA() === repoB();

  // Zones present in BOTH sides (only these can diff). Falls back to whichever side
  // resolved if the other fails; leaves manual entry working on total failure.
  const loadZones = async () => {
    setZonesMsg("loading zone list…");
    const [a, b] = await Promise.allSettled([listZones(repoA(), refA()), listZones(repoB(), refB())]);
    const listA = a.status === "fulfilled" ? a.value : undefined;
    const listB = b.status === "fulfilled" ? b.value : undefined;
    if (!listA && !listB) {
      setZones([]);
      setZonesMsg("could not load zone list — type a zone name manually");
      return;
    }

    const both = listA && listB ? listA.filter(z => new Set(listB).has(z)) : (listA ?? listB)!;
    setZones(both);
    setZonesMsg(`${both.length} zones`);
  };

  const fetchNav = async (repo: string, ref: string, z: string): Promise<ArrayBuffer> => {
    const res = await fetch(rawUrl(repo, ref, z));
    if (!res.ok) {
      throw new Error(`${repo}@${ref}/${z}.nav → HTTP ${res.status}`);
    }

    return res.arrayBuffer();
  };

  const loadFromGitHub = async () => {
    const z = zone().trim();
    if (!z) {
      setError("Enter a zone name, e.g. Crawlers_Nest");
      return;
    }

    setError(undefined);
    setLoading(true);
    // Reflect the current selection in the URL so it can be shared/bookmarked. Use a single
    // `repo` param when both sides match, else split into repoA/repoB (undefined clears the other).
    setParams({
      repo: sameRepo() ? repoA() : undefined,
      repoA: sameRepo() ? undefined : repoA(),
      repoB: sameRepo() ? undefined : repoB(),
      a: refA(),
      b: refB(),
      zone: z,
    });
    try {
      const [a, b] = await Promise.all([fetchNav(repoA(), refA(), z), fetchNav(repoB(), refB(), z)]);
      // Prefix the repo only when the two sides differ, to keep the common case clean.
      setLabelA(`${sameRepo() ? "" : repoA() + "@"}${refA()} · ${z}`);
      setLabelB(`${sameRepo() ? "" : repoB() + "@"}${refB()} · ${z}`);
      setNavA(a);
      setNavB(b);
      setToken(token() + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setNavA(undefined);
      setNavB(undefined);
    } finally {
      setLoading(false);
    }
  };

  const pickFile = async (file: File | undefined, set: (b: ArrayBuffer) => void, setLabel: (s: string) => void) => {
    if (!file) {
      return;
    }

    setError(undefined);
    try {
      setLabel(file.name);
      set(await file.arrayBuffer());
      if (navA() && navB()) {
        setToken(token() + 1);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; the URL is in the address bar regardless.
    }
  };

  // Populate the zone dropdown, and auto-load when arriving with a zone in the URL.
  onMount(() => {
    void loadZones();
    if (zone().trim()) {
      void loadFromGitHub();
    }
  });

  const field = "px-2 py-1 bg-slate-800 border border-slate-700 rounded text-sm text-slate-100";

  return (
    <section class="px-8 py-4">
      <h1 class="text-2xl font-bold mb-3">Navmesh Diff</h1>

      <div class="flex flex-wrap items-end gap-3 mb-3">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-emerald-400">Repo A</span>
          <input class={`${field} w-52`} value={repoA()} onInput={e => setRepoA(e.currentTarget.value)} onChange={() => loadZones()} />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-emerald-400">Ref A (base)</span>
          <input class={`${field} w-40`} value={refA()} onInput={e => setRefA(e.currentTarget.value)} onChange={() => loadZones()} />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-sky-400">Repo B</span>
          <input class={`${field} w-52`} value={repoB()} onInput={e => setRepoB(e.currentTarget.value)} onChange={() => loadZones()} />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-sky-400">Ref B (new)</span>
          <input class={`${field} w-40`} value={refB()} onInput={e => setRefB(e.currentTarget.value)} onChange={() => loadZones()} />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-slate-400">
            Zone <span class="text-slate-500">{zonesMsg()}</span>
          </span>
          <Show
            keyed
            when={zones().length ? zones() : null}
            fallback={
              <input
                class={`${field} w-52`}
                placeholder="Crawlers_Nest"
                value={zone()}
                onInput={e => setZone(e.currentTarget.value)}
                onKeyDown={e => e.key === "Enter" && loadFromGitHub()}
              />
            }
          >
            <div class="w-52">
              <LookupInput
                options={zones()}
                nameFn={(z: string) => z}
                skipNameSort
                initialId={String(zones().indexOf(zone()))}
                placeholder="Crawlers_Nest"
                onChange={(opt: Option<string>) => {
                  setZone(opt?.name ?? "");
                  if (opt?.name) {
                    void loadFromGitHub();
                  }
                }}
              />
            </div>
          </Show>
        </label>
        <button
          class="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-sm disabled:opacity-50"
          disabled={loading()}
          onClick={loadFromGitHub}
        >
          {loading() ? "Loading…" : "Compare"}
        </button>
        <Show when={navA() && navB()}>
          <button class="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm" onClick={copyLink}>
            {copied() ? "Copied!" : "Copy link"}
          </button>
        </Show>
      </div>

      <Show when={error()}>
        <div class="text-rose-400 text-sm mb-2">{error()}</div>
      </Show>

      <details class="mb-3 text-sm text-slate-400">
        <summary class="cursor-pointer select-none">Or upload local .nav files</summary>
        <div class="flex flex-col gap-2 max-w-lg mt-2">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-slate-300">A — base</span>
            <input type="file" accept=".nav" class="text-sm" onChange={e => pickFile(e.currentTarget.files?.[0], setNavA, setLabelA)} />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-slate-300">B — new</span>
            <input type="file" accept=".nav" class="text-sm" onChange={e => pickFile(e.currentTarget.files?.[0], setNavB, setLabelB)} />
          </label>
        </div>
      </details>

      <Show
        when={navA() && navB()}
        fallback={<div class="text-xs text-slate-500">Enter repos + refs + a zone and hit Compare, or open a shared link.</div>}
      >
        <div class="flex items-center gap-3 mb-2 text-sm">
          <span class="text-slate-400">
            A: <span class="text-slate-200">{labelA()}</span> &nbsp;→&nbsp; B: <span class="text-slate-200">{labelB()}</span>
          </span>
        </div>
        <Show keyed when={token()}>
          <NavMeshCompareViewer
            navA={navA()!}
            navB={navB()!}
            labelA={labelA()}
            labelB={labelB()}
            repo={sameRepo() ? repoA() : `${repoA()} ↔ ${repoB()}`}
          />
        </Show>
      </Show>
    </section>
  );
}
