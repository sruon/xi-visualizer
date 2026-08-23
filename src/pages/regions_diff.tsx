import { useSearchParams } from "@solidjs/router";
import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import RegionDiffViewer, { STATUS_COLOR } from "../components/region_diff_viewer";
import zones from "../data/zones";
import { diffRegions, parseMobsYaml, parseRegionsYaml, zoneOfMobId } from "../regions";
import type { RegionsDiff, ZoneSide } from "../regions";
import { loadZoneMesh } from "../zone_mesh";

const DEFAULT_REPO = "sruon/server";
const ZONES = "data/zones";

const raw = (repo: string, ref: string, zone: string, file: string) => `https://raw.githubusercontent.com/${repo}/${ref}/${ZONES}/${zone}/${file}`;

async function side(repo: string, ref: string, zone: string): Promise<ZoneSide> {
  const get = (file: string) => fetch(raw(repo, ref, zone, file)).then(r => (r.ok ? r.text() : null));
  const [regionsYaml, mobsYaml] = await Promise.all([get("regions.yaml"), get("mobs.yaml")]);
  // A ref that predates the zone reads as empty, so everything in the other one counts as added.
  if (!mobsYaml) return { regions: {}, spawns: [] };
  return { regions: regionsYaml ? parseRegionsYaml(regionsYaml) : {}, spawns: parseMobsYaml(mobsYaml) };
}

export default function RegionsDiffPage() {
  const [query, setQuery] = useSearchParams<{ repo?: string; base?: string; head?: string; zone?: string; }>();
  const repo = () => query.repo || DEFAULT_REPO;
  const [error, setError] = createSignal<string | undefined>();
  const [status, setStatus] = createSignal<string | undefined>();
  const [focus, setFocus] = createSignal<{ name: string; } | undefined>();

  // Branches to compare, and the zones each ref carries.
  const [branches] = createResource(repo, async name => {
    const [info, list] = await Promise.all([
      fetch(`https://api.github.com/repos/${name}`).then(r => r.json()),
      fetch(`https://api.github.com/repos/${name}/branches?per_page=100`).then(r => r.json()),
    ]);
    const names = (Array.isArray(list) ? list : []).map((b: any) => b.name as string).sort();
    // Both in one call: two setQuery in a row race, and the second wins with a stale location.
    const fallback = names.find(n => n.startsWith("regions/")) ?? names.find(n => n !== info.default_branch);
    setQuery({ base: query.base ?? info.default_branch ?? "main", head: query.head ?? fallback }, { replace: true });
    return names;
  });

  const [zoneList] = createResource(
    () => (query.head ? { repo: repo(), ref: query.head } : undefined),
    async ({ repo, ref }) => {
      const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`);
      const json = (await res.json()) as { tree?: { path: string; }[]; };
      const wanted = new RegExp(`^${ZONES}/([^/]+)/mobs\\.yaml$`);
      return (json.tree ?? []).map(e => e.path.match(wanted)?.[1]).filter((n): n is string => !!n).sort();
    },
  );

  const [pair] = createResource(
    () => (query.base && query.head && query.zone ? { base: query.base, head: query.head, zone: query.zone } : undefined),
    async ({ base, head, zone }) => {
      setError(undefined);
      setStatus(`Loading ${zone}…`);
      try {
        const [a, b] = await Promise.all([side(repo(), base, zone), side(repo(), head, zone)]);
        setStatus(undefined);
        return { base: a, head: b, diff: diffRegions(a, b) };
      } catch (e) {
        setStatus(undefined);
        setError(`${zone}: ${e}`);
        throw e;
      }
    },
  );

  const zoneId = () => {
    const first = pair()?.head.spawns[0] ?? pair()?.base.spawns[0];
    return first ? zoneOfMobId(first.id) : undefined;
  };
  const [mesh] = createResource(zoneId, id => loadZoneMesh(id, setStatus));

  const total = (d: RegionsDiff) => d.added.length + d.removed.length + d.reshaped.length + d.moved.length;
  const swatch = (kind: keyof typeof STATUS_COLOR) => `#${STATUS_COLOR[kind].toString(16)}`;

  createEffect(() => {
    if (branches.error) setError(`${repo()}: ${branches.error}`);
  });

  return (
    <section class="p-8">
      <div class="flex flex-wrap items-center gap-3 text-sm">
        <h1 class="text-2xl font-bold mr-2">Regions Diff</h1>
        {/* query[which] is read inside the JSX so the value tracks; an array literal would snapshot it */}
        <For each={["base", "head"] as const}>
          {which => (
            <label class="flex items-center gap-2">
              <span class="text-slate-400">{which}</span>
              <Picker options={branches() ?? []} value={query[which]} empty="pick a branch" onChange={v => setQuery({ [which]: v })} />
            </label>
          )}
        </For>
        <Picker
          options={zoneList() ?? []}
          value={query.zone}
          empty={zoneList()?.length ? `${zoneList()!.length} zones, pick one` : "no zones"}
          onChange={v => setQuery({ zone: v })}
        />
        <Show when={pair()}>
          <span class="text-slate-400">
            {zones[zoneId()!]?.name ?? "?"} · {total(pair()!.diff) || "no"} changes
          </span>
        </Show>
        <Show when={status()}>
          <span class="text-slate-400">{status()}</span>
        </Show>
        <Show when={error()}>
          <span class="text-red-500">{error()}</span>
        </Show>
      </div>

      <Show
        when={pair() && mesh()}
        fallback={<div class="mt-4 text-slate-400">Pick two branches and a zone to compare.</div>}
      >
        <div class="flex gap-4 mt-4" style={{ height: "78vh" }}>
          <div class="flex-1">
            <RegionDiffViewer zoneData={mesh()!} base={pair()!.base} head={pair()!.head} diff={pair()!.diff} focus={focus()} />
          </div>

          <div class="w-96 flex flex-col bg-slate-800 rounded-lg p-2 overflow-y-auto text-sm">
            <Show when={total(pair()!.diff) === 0}>
              <div class="text-emerald-500 p-2">These two are identical.</div>
            </Show>

            <For each={pair()!.diff.added}>
              {name => (
                <DiffRow color={swatch("added")} mark="+" onClick={() => setFocus({ name })}>
                  <b>{name}</b> added, {pair()!.head.regions[name].rings[0]?.length ?? 0}v, {pair()!.head.spawns.filter(s => s.region === name).length} spawns
                </DiffRow>
              )}
            </For>
            <For each={pair()!.diff.removed}>
              {name => (
                <DiffRow color={swatch("removed")} mark="−" onClick={() => setFocus({ name })}>
                  <b>{name}</b> removed, held {pair()!.base.spawns.filter(s => s.region === name).length} spawns
                </DiffRow>
              )}
            </For>
            <For each={pair()!.diff.reshaped}>
              {change => (
                <DiffRow color={swatch("reshaped")} mark="~" onClick={() => setFocus({ name: change.name })}>
                  <b>{change.name}</b> reshaped, {change.fromVertices}v to {change.toVertices}v, area {change.areaRatio >= 1 ? "+" : ""}
                  {((change.areaRatio - 1) * 100).toFixed(0)}%
                </DiffRow>
              )}
            </For>
            <Show when={pair()!.diff.moved.length}>
              <div class="text-xs uppercase tracking-wide text-slate-500 mt-2 px-1">
                {pair()!.diff.moved.length} spawns moved
              </div>
              <For each={pair()!.diff.moved}>
                {move => (
                  <DiffRow color={swatch("reshaped")} mark="~" onClick={() => move.to && setFocus({ name: move.to })}>
                    <span class="text-slate-300">{move.name}</span> <span class="text-slate-500">{move.id}</span> {move.from ?? "unmapped"} →{" "}
                    {move.to ?? "unmapped"}
                  </DiffRow>
                )}
              </For>
            </Show>
            <Show when={pair()!.diff.addedSpawns.length || pair()!.diff.removedSpawns.length}>
              <div class="text-xs text-slate-500 mt-2 px-1">
                mobs.yaml itself changed: {pair()!.diff.addedSpawns.length} spawns added, {pair()!.diff.removedSpawns.length} removed
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </section>
  );
}

/** A select whose value is re-applied once its options exist; setting it earlier is a no-op. */
function Picker(props: { options: string[]; value?: string; empty: string; onChange: (value: string) => void; }) {
  let el!: HTMLSelectElement;
  createEffect(() => {
    el.value = props.options.includes(props.value ?? "") ? props.value! : "";
  });
  return (
    <select ref={el} class="px-2 py-1 bg-slate-700 rounded max-w-56" onChange={e => props.onChange(e.currentTarget.value)}>
      <option value="">{props.empty}</option>
      <For each={props.options}>{o => <option value={o}>{o}</option>}</For>
    </select>
  );
}

function DiffRow(props: { color: string; mark: string; onClick: () => void; children: any; }) {
  return (
    <div class="flex gap-2 py-0.5 px-1 rounded hover:bg-slate-700 cursor-pointer text-xs" onClick={props.onClick}>
      <span style={{ color: props.color }}>{props.mark}</span>
      <span class="text-slate-300">{props.children}</span>
    </div>
  );
}
