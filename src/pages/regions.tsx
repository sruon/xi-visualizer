import { useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import RegionEditor from "../components/region_editor";
import YamlView from "../components/yaml_view";
import type { ZoneData } from "../components/zone_model";
import zones from "../data/zones";
import { propose } from "../github";
import { canSignIn, type DeviceCode, requestCode, signOut, storedToken, waitForToken } from "../github_auth";
import { emitRegionsBlock, parseMobsYaml, parseZoneYaml, patchMobsYaml, patchZoneYaml, zoneOfMobId } from "../regions";
import type { Patrol, RegionSet, Spawn } from "../regions";
import { decompress, fetchProgress } from "../util";

const PATHDATA = import.meta.env.VITE_PATHDATA_URL || `${import.meta.env.BASE_URL}/pathdata_gz`;

/** Flattened roam trails: one buffer for the whole zone, plus where each mob's points live in it. */
export interface RoamData {
  positions: Float32Array;
  times: Float64Array;
  ranges: Record<string, [number, number]>;
  count: number;
}

// data/zones/<zone>/{zone.yaml,mobs.yaml} straight out of the LSB checkout.
interface ZoneFiles {
  folder: string;
  zoneYaml: string;
  mobsYaml: string;
}

// Unsaved work is mirrored to localStorage so a closed tab or a crash does not lose it. One draft
// per zone folder, dropped as soon as the files are written or the edits are undone.
interface Draft {
  at: number;
  regions: RegionSet;
  assign: Record<string, string>;
  paths?: Record<string, Patrol>;
}

const DEFAULT_REPO = "sruon/lsb-roam-data-temp";
const ZONES = "data/zones"; // where the zone folders live inside the repo
const TOKEN_KEY = "xi-visualizer:github-token";
const LOCAL = "/local-zones"; // dev middleware over a folder on disk, see vite.config.ts

/**
 * Draft slot for a zone, identified by the files it was taken from and not just the folder name.
 *
 * Keying on the name alone meant every `west_ronfaure` shared one slot -- the repo's, a local
 * folder's, an LSB checkout's -- so a stale draft from one source was silently restored over
 * another and the page showed different geometry depending on when it was last reloaded.
 */
const draftKey = (folder: string, source: string) => `xi-visualizer:regions-draft:${folder}:${source}`;

/** Cheap non-cryptographic digest, only needs to tell one version of a file from another. */
function fingerprint(...texts: string[]): string {
  let h = 0x811c9dc5;
  for (const text of texts) {
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(36);
}

function readDraft(folder: string, source: string): Draft | undefined {
  try {
    return JSON.parse(localStorage.getItem(draftKey(folder, source)) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Drops draft slots for this zone that no longer match the files in front of us. */
function dropStaleDrafts(folder: string, source: string) {
  const keep = draftKey(folder, source);
  const prefix = `xi-visualizer:regions-draft:${folder}`;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k !== keep && (k === prefix || k.startsWith(`${prefix}:`))) localStorage.removeItem(k);
  }
}

export default function RegionsPage() {
  // /regions/<zone> picks the zone; ?repo=owner/name&ref=branch override where it comes from.
  const params = useParams<{ zone?: string; }>();
  const [query] = useSearchParams<{ repo?: string; ref?: string; }>();
  const navigate = useNavigate();
  const repo = () => query.repo || DEFAULT_REPO;
  const ref = () => query.ref || "HEAD";
  // A signed-in token wins over a pasted one, but both end up in the same place: a bearer token
  // for api.github.com, which is CORS-enabled and needs no help from anybody.
  const [account, setAccount] = createSignal(storedToken());
  const [device, setDevice] = createSignal<DeviceCode | undefined>();
  const [signingIn, setSigningIn] = createSignal(false);
  const [token, setToken] = createSignal(localStorage.getItem(TOKEN_KEY) ?? "");
  const authToken = () => account()?.token || token();

  const startSignIn = async () => {
    setError(undefined);
    setSigningIn(true);
    try {
      const code = await requestCode();
      setDevice(code);
      window.open(code.verificationUri, "_blank", "noopener");
      setAccount(await waitForToken(code));
      setDevice(undefined);
      setAskToken(false);
    } catch (e) {
      setError(`${e}`);
      setDevice(undefined);
    } finally {
      setSigningIn(false);
    }
  };
  const [askToken, setAskToken] = createSignal(false);
  const [pr, setPr] = createSignal<{ url: string; note: string; } | undefined>();
  const [local, setLocal] = createSignal(false);
  const [folders, setFolders] = createSignal<string[]>([]);
  const [files, setFiles] = createSignal<ZoneFiles | undefined>();
  const [error, setError] = createSignal<string | undefined>();
  const [status, setStatus] = createSignal<string | undefined>();
  const [dirty, setDirty] = createSignal(false);
  const [showYaml, setShowYaml] = createSignal(false);
  // Bumped on every edit so the yaml panel can follow along. Patching is a few milliseconds, and
  // this only runs while the panel is open.
  const [edits, setEdits] = createSignal(0);
  const [draft, setDraft] = createSignal<Draft | undefined>();
  const [restored, setRestored] = createSignal<Draft | undefined>();
  // Fingerprint of the files currently open, so a draft belongs to the version it was taken from.
  const [source, setSource] = createSignal("");
  const [editorKey, setEditorKey] = createSignal("");

  // Latest editor state, written back on save.
  let pending: { regions: RegionSet; assign: Record<string, string>; paths: Record<string, Patrol>; } | undefined;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let edited = false;

  const clearDraft = (folder: string) => {
    localStorage.removeItem(draftKey(folder, source()));
    setDraft(undefined);
  };

  // Debounced: onChange fires on every mouse move while a vertex is being dragged.
  const scheduleDraft = (isDirty: boolean) => {
    clearTimeout(draftTimer);
    const f = files();
    if (!f) return;
    // Only drop a draft once this session has made an edit of its own — the editor reports "not
    // dirty" as soon as it mounts, which would otherwise wipe the draft before it can be offered.
    if (!isDirty) return edited && clearDraft(f.folder);
    edited = true;
    draftTimer = setTimeout(() => {
      if (!pending) return;
      try {
        localStorage.setItem(draftKey(f.folder, source()), JSON.stringify({ at: Date.now(), ...pending }));
      } catch (e) {
        setError(`autosave failed: ${e}`);
      }
    }, 700);
  };

  onMount(() => {
    listZones();
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty()) e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    onCleanup(() => {
      window.removeEventListener("beforeunload", guard);
      clearTimeout(draftTimer);
    });
  });

  // The URL is the source of truth for which zone is open, so deep links work without the listing.
  createEffect(() => {
    const zone = params.zone;
    if (zone && zone !== untrack(files)?.folder) openZone(zone);
  });

  // Parsed once when the zone is opened and never re-derived from a patched file: assigning a
  // region strips `at:`, so re-parsing after a save would lose every assigned spawn's coordinates.
  const [spawns, setSpawns] = createSignal<Spawn[] | undefined>();
  const [regions, setRegions] = createSignal<RegionSet>({});
  const [baseline, setBaseline] = createSignal({ block: "", assign: {} as Record<string, string>, paths: "" });

  // Coordinates as the file had them, so unassigning can put `at:` back.
  const positions = () => Object.fromEntries((spawns() ?? []).filter(s => s.at).map(s => [s.id, s.at!]));

  const zoneId = () => {
    const first = spawns()?.[0];
    return first ? zoneOfMobId(first.id) : undefined;
  };

  const listZones = async () => {
    // In dev, a local zones folder wins if the vite middleware has one to serve (see vite.config).
    if (import.meta.env.DEV) {
      try {
        const res = await fetch(`${LOCAL}/`);
        const names = res.ok ? ((await res.json()) as string[]) : [];
        if (names.length) {
          setLocal(true);
          setFolders(names);
          setStatus(undefined);
          setError(undefined);
          return;
        }
      } catch {
        // no local folder, fall through to GitHub
      }
    }
    setLocal(false);
    setStatus(`Listing ${repo()}…`);
    try {
      const res = await fetch(`https://api.github.com/repos/${repo()}/git/trees/${ref()}?recursive=1`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { tree?: { path: string; }[]; };
      const wanted = new RegExp(`^${ZONES}/([^/]+)/mobs\\.yaml$`);
      const names = (json.tree ?? [])
        .map(e => e.path.match(wanted)?.[1])
        .filter((n): n is string => !!n)
        .sort();
      setFolders(names);
      setStatus(undefined);
      setError(names.length ? undefined : `No ${ZONES}/<zone>/mobs.yaml in ${repo()}@${ref()} yet`);
    } catch (e) {
      setStatus(undefined);
      setError(`${repo()}: ${e}`);
    }
  };

  const openZone = async (folder: string) => {
    if (!folder) return;
    setStatus(`Loading ${folder}…`);
    try {
      const url = (name: string) =>
        local()
          ? `${LOCAL}/${folder}/${name}`
          : `https://raw.githubusercontent.com/${repo()}/${ref() === "HEAD" ? "main" : ref()}/${ZONES}/${folder}/${name}`;
      const raw = (name: string) => fetch(url(name)).then(r => (r.ok ? r.text() : Promise.reject(new Error(`${name} → HTTP ${r.status}`))));
      const [zoneYaml, mobsYaml] = await Promise.all([raw("zone.yaml"), raw("mobs.yaml")]);
      open({ folder, zoneYaml, mobsYaml });
      setStatus(undefined);
    } catch (e) {
      setFiles(undefined);
      setStatus(undefined);
      setError(`${folder}: ${e}`);
    }
  };

  const open = (next: ZoneFiles) => {
    let parsed: Spawn[];
    let regionSet: RegionSet;
    try {
      parsed = parseMobsYaml(next.mobsYaml);
      regionSet = parseZoneYaml(next.zoneYaml);
    } catch (e) {
      setFiles(undefined);
      setError(`${next.folder}: ${e}`);
      return;
    }
    edited = false;
    setFiles(next);
    setSpawns(parsed);
    setRegions(regionSet);
    setBaseline({
      block: emitRegionsBlock(regionSet),
      assign: Object.fromEntries(parsed.filter(s => s.region).map(s => [s.id, s.region!])),
      paths: JSON.stringify(Object.fromEntries(parsed.filter(s => s.path).map(s => [s.id, { legs: s.path, loop: s.loop }]))),
    });
    setDirty(false);
    setError(undefined);
    setRestored(undefined);
    const stamp = fingerprint(next.zoneYaml, next.mobsYaml);
    setSource(stamp);
    dropStaleDrafts(next.folder, stamp);
    setDraft(readDraft(next.folder, stamp));
    setEditorKey(next.folder);
  };

  const restoreDraft = () => {
    const d = draft();
    if (!d) return;
    setRestored(d);
    setEditorKey(`${files()!.folder}:${d.at}`);
    setDraft(undefined);
  };

  const yamlFiles = createMemo(() => {
    if (!showYaml()) return undefined;
    edits();
    const out = patched();
    return out && [{ name: "zone.yaml", text: out.zoneYaml }, { name: "mobs.yaml", text: out.mobsYaml }];
  });

  const patched = () => {
    const f = files();
    if (!f || !pending) return undefined;
    return {
      zoneYaml: patchZoneYaml(f.zoneYaml, pending.regions),
      mobsYaml: patchMobsYaml(f.mobsYaml, pending.assign, positions(), pending.paths),
    };
  };

  /** Writes both files back to the local folder through the dev middleware. */
  const saveLocal = async () => {
    const f = files();
    const next = patched();
    if (!f || !next) return;
    setStatus(`Saving ${f.folder}…`);
    try {
      for (const [name, text] of [["zone.yaml", next.zoneYaml], ["mobs.yaml", next.mobsYaml]] as const) {
        const res = await fetch(`${LOCAL}/${f.folder}/${name}`, { method: "PUT", body: text });
        if (!res.ok) throw new Error(`${name} → HTTP ${res.status}`);
      }
      setFiles({ ...f, ...next });
      setBaseline({ block: emitRegionsBlock(pending!.regions), assign: pending!.assign, paths: JSON.stringify(pending!.paths) });
      setDirty(false);
      clearDraft(f.folder);
      setStatus(`Saved ${f.folder}`);
    } catch (e) {
      setStatus(undefined);
      setError(`save: ${e}`);
    }
  };

  const copyPatched = () => {
    const next = patched();
    if (next) navigator.clipboard.writeText(`# --- zone.yaml ---\n${next.zoneYaml}\n# --- mobs.yaml (spawns section) ---\n${next.mobsYaml}`);
  };

  const proposePr = async () => {
    const f = files();
    const next = patched();
    if (!f || !next) return;
    if (!authToken()) return setAskToken(true);

    setStatus(`Pushing ${f.folder}…`);
    setPr(undefined);
    try {
      const result = await propose({
        token: authToken(),
        repo: repo(),
        branch: `regions/${f.folder}`,
        base: ref() === "HEAD" ? undefined : ref(),
        title: `Spawn regions for ${f.folder}`,
        message: `${f.folder}: ${Object.keys(pending!.regions).length} regions, ${Object.keys(pending!.assign).length} spawns assigned`,
        body: "Generated with the xi-visualizer Regions editor.",
        files: [
          { path: `${ZONES}/${f.folder}/zone.yaml`, content: next.zoneYaml },
          { path: `${ZONES}/${f.folder}/mobs.yaml`, content: next.mobsYaml },
        ],
      });
      // Where it went matters: without push access the commits land on the user's own fork.
      const via = result.wrote === repo() ? "" : ` via ${result.wrote}`;
      setPr({
        url: result.url,
        note: (result.unchanged ? "no changes to push" : result.updated ? "updated" : "opened") + via,
      });
      setStatus(undefined);
      if (!result.unchanged) {
        // It is on a branch now, so this is as safe as saving to disk.
        setFiles({ ...f, ...next });
        setBaseline({ block: emitRegionsBlock(pending!.regions), assign: pending!.assign, paths: JSON.stringify(pending!.paths) });
        setDirty(false);
        clearDraft(f.folder);
      }
    } catch (e) {
      setStatus(undefined);
      setError(`${e}`);
    }
  };

  // On by default; a zone's trails are a few MB, so unticking it also stops the fetch.
  const [showRoam, setShowRoam] = createSignal(true);
  const [roam] = createResource(() => (showRoam() ? zoneId() : undefined), async (id): Promise<RoamData> => {
    const file = zones[id].name
      .replaceAll(" - ", "_-_")
      .replaceAll(" ", "_")
      .replaceAll("'", "_")
      .replaceAll("#", "");
    const compressed = await fetchProgress(`${PATHDATA}/${encodeURIComponent(file)}.json.gz`, () => {});
    const data = JSON.parse(new TextDecoder().decode(await decompress(compressed, "gzip")));

    let count = 0;
    for (const mob of Object.values<any>(data)) count += mob.points.length;
    const positions = new Float32Array(count * 3);
    // Capture time, kept because the samples are not evenly spaced: minutes can pass between two of
    // them, and a route must not draw a leg through a stretch where nobody was watching the mob.
    const times = new Float64Array(count);
    const ranges: Record<string, [number, number]> = {};
    let o = 0;
    for (const [mobId, mob] of Object.entries<any>(data)) {
      ranges[mobId] = [o / 3, mob.points.length];
      for (const p of mob.points) {
        times[o / 3] = p.t ?? 0;
        positions[o++] = p.x;
        positions[o++] = p.y;
        positions[o++] = p.z;
      }
    }
    return { positions, times, ranges, count };
  });

  const [zoneMesh] = createResource(zoneId, async id => {
    const zone = zones[id];
    if (!zone) throw new Error(`unknown zone id ${id}`);
    const filename = zone.name
      .replaceAll(" - ", "-")
      .replaceAll(" ", "_")
      .replaceAll("'", "")
      .replaceAll("(", "")
      .replaceAll(")", "")
      .replaceAll("#", "");

    setStatus("Downloading mesh...");
    const compressed = await fetchProgress(`${import.meta.env.BASE_URL}/ximeshes/${filename}.ximesh`, progress => {
      if (progress !== undefined) setStatus(`Downloading mesh ${(progress * 100).toFixed(0)}%`);
    });
    setStatus("Decompressing mesh...");
    const mesh = await decompress(compressed);
    setStatus(undefined);
    return { id, name: zone.name, mesh } as ZoneData;
  });

  return (
    <section class="p-8">
      <div class="flex flex-wrap items-center gap-3 text-sm">
        <h1 class="text-2xl font-bold mr-2">Spawn Regions</h1>
        {/* value depends on folders() so it re-applies once the options exist */}
        <select
          class="px-2 py-1 bg-slate-700 rounded max-w-64"
          value={folders().includes(params.zone ?? "") ? params.zone! : ""}
          title={local() ? "served from a local folder" : `${repo()}@${ref()}`}
          onChange={e => navigate(`/regions/${e.currentTarget.value}`)}
        >
          <option value="">{folders().length ? `${folders().length} zones, pick one` : "no zones"}</option>
          <For each={folders()}>{f => <option value={f}>{f}</option>}</For>
        </select>
        <button
          class="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded"
          onClick={listZones}
          title={local() ? "Re-read the local folder" : `Re-read ${repo()}@${ref()}`}
        >
          ⟳
        </button>
        <Show when={files()}>
          <span class="text-slate-400">
            {zones[zoneId()!]?.name ?? "?"} ({zoneId()}) · {spawns()?.length ?? 0} spawns
          </span>
          <button
            class="px-2 py-1 rounded"
            classList={{ "bg-emerald-600 hover:bg-emerald-500": dirty(), "bg-slate-700 text-slate-400": !dirty() }}
            onClick={local() ? saveLocal : proposePr}
            title={local() ? "Write both files back to the local folder" : "Commit to a branch and open a pull request"}
          >
            {local() ? (dirty() ? "Save" : "Saved") : dirty() ? "Propose PR" : "Pushed"}
          </button>
          <button class="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded" onClick={copyPatched}>Copy YAML</button>
          <button
            class="px-2 py-1 rounded"
            classList={{ "bg-slate-600 text-white": showYaml(), "bg-slate-700 hover:bg-slate-600": !showYaml() }}
            title="Show the files as they would be written"
            onClick={() => setShowYaml(v => !v)}
          >
            {showYaml() ? "Hide YAML" : "View YAML"}
          </button>
        </Show>
        <Show when={files()}>
          <label class="flex items-center gap-2 text-slate-400 cursor-pointer" title="Overlay the recorded roam trails for this zone">
            <input type="checkbox" checked={showRoam()} onChange={e => setShowRoam(e.currentTarget.checked)} />
            roam data
            <Show when={showRoam()}>
              <span class="text-slate-500">
                {roam.error ? "none for this zone" : roam() ? `${(roam()!.count / 1000).toFixed(0)}k points` : "loading…"}
              </span>
            </Show>
          </label>
        </Show>
        <Show when={status()}>
          <span class="text-slate-400">{status()}</span>
        </Show>
        <Show when={pr()}>
          <a class="text-emerald-400 underline" href={pr()!.url} target="_blank" rel="noreferrer">PR {pr()!.note}</a>
        </Show>
        <Show when={error()}>
          <span class="text-red-500">{error()}</span>
        </Show>
        <Show when={account()}>
          {who => (
            <span class="text-slate-400">
              {who().login}
              <button
                class="ml-2 px-1.5 py-0.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                onClick={() => (signOut(), setAccount(null))}
              >
                sign out
              </button>
            </span>
          )}
        </Show>
      </div>

      <Show when={askToken()}>
        <div class="mt-3 flex flex-wrap items-center gap-2 text-sm bg-slate-800 border border-slate-600 rounded px-3 py-2">
          <Show when={canSignIn()}>
            <Show
              when={device()}
              fallback={
                <>
                  <button
                    class="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 rounded disabled:opacity-50"
                    disabled={signingIn()}
                    onClick={startSignIn}
                  >
                    Sign in with GitHub
                  </button>
                  <span class="text-slate-400">
                    Opens github.com to confirm a code. No push access needed: without it the change goes to a fork and the pull request comes back here.
                  </span>
                </>
              }
            >
              {code => (
                <>
                  <span>
                    Type <b class="font-mono text-lg tracking-widest text-emerald-400">{code().userCode}</b> at{" "}
                    <a class="underline" href={code().verificationUri} target="_blank" rel="noreferrer">{code().verificationUri}</a>
                  </span>
                  <span class="text-slate-400">Waiting for you to confirm…</span>
                </>
              )}
            </Show>
            <span class="text-slate-600">or</span>
          </Show>
          <span>
            GitHub token: a fine-grained one limited to <b>{repo()}</b> with Contents and Pull requests set to read/write.
          </span>
          <input
            type="password"
            class="px-2 py-1 bg-slate-700 rounded w-72"
            placeholder="github_pat_…"
            onChange={e => setToken(e.currentTarget.value.trim())}
          />
          <button
            class="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 rounded"
            onClick={() => {
              localStorage.setItem(TOKEN_KEY, token());
              setAskToken(false);
              proposePr();
            }}
          >
            Save &amp; propose
          </button>
          <button
            class="px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded"
            onClick={() => {
              localStorage.removeItem(TOKEN_KEY);
              setToken("");
              setAskToken(false);
            }}
          >
            Forget
          </button>
          <span class="text-slate-500">Kept in this browser's localStorage, sent only to api.github.com.</span>
        </div>
      </Show>

      <Show when={draft()}>
        <div class="mt-3 flex items-center gap-3 text-sm bg-amber-900/40 border border-amber-700 rounded px-3 py-2">
          <span>
            Unsaved work on {files()!.folder} from {new Date(draft()!.at).toLocaleString()}: {Object.keys(draft()!.regions).length} regions,{" "}
            {Object.keys(draft()!.assign).length} assignments.
          </span>
          <button class="px-2 py-1 bg-amber-600 hover:bg-amber-500 rounded" onClick={restoreDraft}>Restore</button>
          <button class="px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded" onClick={() => clearDraft(files()!.folder)}>Discard</button>
        </div>
      </Show>

      <Show when={files()} fallback={<div class="mt-4 text-slate-400">Pick a zone.</div>}>
        <Switch>
          <Match when={zoneMesh.loading}>
            <div class="mt-4">Loading... {status()}</div>
          </Match>
          <Match when={zoneMesh.error}>
            <div class="mt-4 text-red-500">Failed to load zone mesh: {zoneMesh.error?.toString()}</div>
          </Match>
          <Match when={zoneMesh() && spawns()}>
            <div class="mt-4">
              <Show when={yamlFiles()}>
                {files => <YamlView files={files()} onClose={() => setShowYaml(false)} />}
              </Show>
              {
                /* Hidden rather than unmounted: taking the editor down would drop the webgl context
                  and reload the zone on the way back. */
              }
              <div style={{ display: showYaml() ? "none" : "block" }}>
                <Show when={editorKey()} keyed>
                  {_key => (
                    <RegionEditor
                      zoneData={zoneMesh()!}
                      spawns={spawns()!}
                      regions={restored()?.regions ?? regions()}
                      assign={restored()?.assign}
                      paths={restored()?.paths}
                      roam={showRoam() && !roam.loading && !roam.error ? roam() : undefined}
                      onChange={(r, a, p) => {
                        pending = { regions: r, assign: a, paths: p };
                        // Compared against the last saved state, not by re-patching: this runs on
                        // every mouse move during a vertex drag and mobs.yaml is thousands of lines.
                        const base = baseline();
                        const sameAssign = Object.keys(a).length === Object.keys(base.assign).length
                          && Object.entries(a).every(([id, n]) => base.assign[id] === n);
                        const isDirty = !sameAssign || emitRegionsBlock(r) !== base.block || JSON.stringify(p) !== base.paths;
                        setDirty(isDirty);
                        setEdits(n => n + 1);
                        scheduleDraft(isDirty);
                      }}
                    />
                  )}
                </Show>
              </div>
            </div>
          </Match>
        </Switch>
      </Show>
    </section>
  );
}
