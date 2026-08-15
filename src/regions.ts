import { load } from "js-yaml";

// A vertex is [x, y, z]: earcut triangulates on x/z and carries y through, so the polygon
// describes the floor surface itself. Stacked floors are told apart by whose floor is nearer.
export type Vertex = [number, number, number];
export type Ring = Vertex[];

export interface Region {
  rings: Ring[]; // rings[0] is the outline, the rest are holes
}

export type RegionSet = Record<string, Region>;

export interface Spawn {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  /** Raw `at:` as written, [x, y, z, rot?]. Absent once a region took over placement. */
  at?: number[];
  region?: string;
}

// Zone ids run past 255 (Yorcia Weald is 263, Reisenjima 291), so masking to a byte aliases every
// zone above the boundary onto a classic one: Yorcia onto Attohwa Chasm, Reisenjima onto Ru'Hmet.
export function zoneOfMobId(mobId: string | number): number {
  return (Number(mobId) >> 12) & 0xfff;
}

// --- parsing ---

export function parseZoneYaml(text: string): RegionSet {
  const doc = load(text) as any;
  const out: RegionSet = {};
  for (const [name, r] of Object.entries<any>(doc?.regions ?? {})) {
    out[name] = { rings: [r?.poly ?? [], ...(r?.holes ?? [])] };
  }
  return out;
}

export function parseMobsYaml(text: string): Spawn[] {
  const doc = load(text) as any;
  if (!doc?.spawns) throw new Error("no `spawns:` section in this file");
  return Object.entries<any>(doc.spawns).map(([id, s]) => ({
    id: String(id),
    name: s?.template ?? "unknown",
    x: s?.at?.[0] ?? 0,
    y: s?.at?.[1] ?? 0,
    z: s?.at?.[2] ?? 0,
    at: Array.isArray(s?.at) ? s.at.map(Number) : undefined,
    region: s?.region ? String(s.region) : undefined,
  }));
}

// --- emitting ---

const n2 = (v: number) => v.toFixed(2);
const vtx = (v: Vertex) => `[${n2(v[0])}, ${n2(v[1])}, ${n2(v[2])}]`;

// Canonical: regions sorted by name, each ring rotated to start at its smallest vertex, so a
// regenerated or re-saved file diffs cleanly against the last one.
function canonicalRing(ring: Ring): Ring {
  if (ring.length < 2) return ring;
  let start = 0;
  for (let i = 1; i < ring.length; i++) {
    const [ax, , az] = ring[i];
    const [bx, , bz] = ring[start];
    if (ax < bx || (ax === bx && az < bz)) start = i;
  }
  return [...ring.slice(start), ...ring.slice(0, start)];
}

export function emitRegionsBlock(regions: RegionSet): string {
  const names = Object.keys(regions).sort();
  if (!names.length) return "";
  const out = ["regions:"];
  for (const name of names) {
    const rings = regions[name].rings;
    out.push("", `  ${name}:`);
    out.push("    poly:");
    for (const v of canonicalRing(rings[0] ?? [])) out.push(`      - ${vtx(v)}`);
    if (rings.length > 1) {
      out.push("    holes:");
      for (const hole of rings.slice(1)) {
        canonicalRing(hole).forEach((v, i) => out.push(`      ${i === 0 ? "-" : " "} - ${vtx(v)}`));
      }
    }
  }
  return out.join("\n") + "\n";
}

function splitLines(text: string) {
  return { lines: text.split(/\r?\n/), eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

// End of the top-level block starting at `start` (its header line included).
function blockEnd(lines: string[], start: number) {
  let i = start + 1;
  while (i < lines.length && !/^\S/.test(lines[i])) i++;
  while (i > start + 1 && lines[i - 1].trim() === "") i--; // leave trailing blank lines alone
  return i;
}

/** Replaces (or appends) the top-level `regions:` block, leaving the rest of zone.yaml untouched. */
export function patchZoneYaml(text: string, regions: RegionSet): string {
  const { lines, eol } = splitLines(text);
  const block = emitRegionsBlock(regions).split("\n").slice(0, -1);
  const at = lines.findIndex(l => /^regions:\s*$/.test(l));

  if (at >= 0) {
    lines.splice(at, blockEnd(lines, at) - at, ...block);
  } else if (block.length) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", ...block, "");
  }
  return lines.join(eol);
}

/**
 * Adds, updates or removes the `region:` key on each spawn entry in mobs.yaml. A region replaces the
 * fixed spawn point, so `at:` is dropped from an assigned spawn and put back from `positions` when
 * one is unassigned. Line surgery on purpose: the file is mostly a generated comment header plus
 * templates we must not reformat.
 */
export function patchMobsYaml(text: string, assign: Record<string, string>, positions: Record<string, number[]> = {}): string {
  const { lines, eol } = splitLines(text);
  const start = lines.findIndex(l => /^spawns:\s*$/.test(l));
  if (start < 0) throw new Error("no `spawns:` section in this file");
  const end = blockEnd(lines, start);

  const out = lines.slice(0, start + 1);
  let id: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (id === null) return;
    const region = assign[id];
    const keep = body.filter(l => !/^\s+region:/.test(l) && !(region && /^\s+at:/.test(l)));

    if (!region && !keep.some(l => /^\s+at:/.test(l)) && positions[id]) {
      const at = positions[id].map((n, i) => (i < 3 ? n.toFixed(3) : String(n))).join(", ");
      let after = keep.findLastIndex(l => /^\s+(template|script):/.test(l));
      keep.splice(after + 1, 0, `    at:       [${at}]`);
    }
    if (region) {
      let last = keep.length;
      while (last > 0 && keep[last - 1].trim() === "") last--;
      keep.splice(last, 0, `    region:   ${region}`);
    }
    out.push(...keep);
    id = null;
    body = [];
  };

  for (let i = start + 1; i < end; i++) {
    const entry = lines[i].match(/^ {2}(\d+):\s*$/);
    if (entry) {
      flush();
      id = entry[1];
      out.push(lines[i]);
    } else if (id !== null) {
      body.push(lines[i]);
    } else {
      out.push(lines[i]);
    }
  }
  flush();
  out.push(...lines.slice(end));
  return out.join(eol);
}

// --- geometry ---

function inRingXZ(ring: Ring, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, , zi] = ring[i];
    const [xj, , zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outline and not inside a hole. Purely horizontal: floors are told apart by y. */
export function containsXZ(r: Region, x: number, z: number): boolean {
  if (!r.rings[0] || r.rings[0].length < 3 || !inRingXZ(r.rings[0], x, z)) return false;
  return !r.rings.slice(1).some(h => inRingXZ(h, x, z));
}

// ponytail: nearest outline vertex, not barycentric interpolation over the triangulation.
// Floors are flat enough that this picks the right one; upgrade if a sloped stacked region misbehaves.
export function floorYAt(r: Region, x: number, z: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (const [vx, vy, vz] of r.rings[0] ?? []) {
    const d = (vx - x) ** 2 + (vz - z) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = vy;
    }
  }
  return best;
}

function spanXZ(r: Region): number {
  const ring = r.rings[0] ?? [];
  if (!ring.length) return Infinity;
  const xs = ring.map(v => v[0]);
  const zs = ring.map(v => v[2]);
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
}

/** Region at a point: horizontal containment, then whichever floor is nearest, then the smallest. */
export function regionAt(regions: RegionSet, x: number, z: number, y: number): string | null {
  const over = Object.entries(regions).filter(([, r]) => containsXZ(r, x, z));
  if (!over.length) return null;
  let best = over[0];
  let bestKey = [Math.abs(floorYAt(best[1], x, z) - y), spanXZ(best[1])];
  for (const cand of over.slice(1)) {
    const key = [Math.abs(floorYAt(cand[1], x, z) - y), spanXZ(cand[1])];
    if (key[0] < bestKey[0] - 0.001 || (Math.abs(key[0] - bestKey[0]) <= 0.001 && key[1] < bestKey[1])) {
      best = cand;
      bestKey = key;
    }
  }
  return best[0];
}

/**
 * Visvalingam-Whyatt: repeatedly drop the vertex whose triangle with its neighbours is smallest,
 * until every remaining one covers more than `minArea` square yalms. Keeps the shape's silhouette
 * where a distance-based filter would flatten curves.
 */
export function simplifyRing(ring: Ring, minArea = 4): Ring {
  // ponytail: recomputes areas each pass instead of keeping a heap, fine for a few hundred vertices.
  const out = ring.slice();
  const areaAt = (i: number) => {
    const [ax, , az] = out[(i - 1 + out.length) % out.length];
    const [bx, , bz] = out[i];
    const [cx, , cz] = out[(i + 1) % out.length];
    return Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
  };
  while (out.length > 3) {
    let worst = 0;
    let worstArea = Infinity;
    for (let i = 0; i < out.length; i++) {
      const a = areaAt(i);
      if (a < worstArea) {
        worstArea = a;
        worst = i;
      }
    }
    if (worstArea > minArea) break;
    out.splice(worst, 1);
  }
  return out;
}

// ponytail: O(n^2) edge pairs, fine for the few dozen vertices a simplified region carries.
export function selfIntersects(ring: Ring): boolean {
  const cross = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => Math.sign((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (i === j || (i + 1) % n === j || (j + 1) % n === i) continue;
      const [ax, , az] = ring[i];
      const [bx, , bz] = ring[(i + 1) % n];
      const [cx, , cz] = ring[j];
      const [dx, , dz] = ring[(j + 1) % n];
      const d1 = cross(ax, az, bx, bz, cx, cz);
      const d2 = cross(ax, az, bx, bz, dx, dz);
      const d3 = cross(cx, cz, dx, dz, ax, az);
      const d4 = cross(cx, cz, dx, dz, bx, bz);
      if (d1 !== d2 && d3 !== d4) return true;
    }
  }
  return false;
}

// --- review ---

export interface Finding {
  level: "error" | "warn" | "info";
  text: string;
  region?: string;
  spawnId?: string;
}

export function validate(regions: RegionSet, spawns: Spawn[], assign: Record<string, string>): Finding[] {
  const findings: Finding[] = [];
  const counts: Record<string, number> = {};
  for (const name of Object.values(assign)) counts[name] = (counts[name] ?? 0) + 1;

  for (const [name, r] of Object.entries(regions)) {
    r.rings.forEach((ring, i) => {
      if (ring.length < 3) findings.push({ level: "error", region: name, text: `${i ? "hole" : "outline"} has only ${ring.length} vertices` });
      else if (selfIntersects(ring)) findings.push({ level: "error", region: name, text: `${i ? "hole" : "outline"} crosses itself` });
    });
    if (!counts[name]) findings.push({ level: "warn", region: name, text: "no spawns assigned" });
  }

  for (const s of spawns) {
    const name = assign[s.id];
    if (!name) continue;
    if (!regions[name]) {
      findings.push({ level: "error", spawnId: s.id, region: name, text: `${s.name} points at undefined region ${name}` });
      continue;
    }
    if (!s.at) continue; // placed by its region now, nothing to check against
    const nearest = regionAt(regions, s.x, s.z, s.y);
    if (!containsXZ(regions[name], s.x, s.z)) {
      findings.push({ level: "info", spawnId: s.id, region: name, text: `${s.name} stands outside ${name}` });
    } else if (nearest && nearest !== name) {
      findings.push({ level: "warn", spawnId: s.id, region: name, text: `${s.name} is nearer ${nearest}'s floor` });
    }
  }

  const loose = spawns.filter(s => !assign[s.id]);
  if (loose.length) findings.push({ level: "info", text: `${loose.length} spawns unassigned` });

  // A region replaces `at:`, so a spawn with neither has nowhere to be placed. Counted rather than
  // listed: zones ship with entries that never had a position, and one line per spawn buries the
  // findings that need acting on.
  const nowhere = loose.filter(s => !s.at).length;
  if (nowhere) findings.push({ level: "warn", text: `${nowhere} spawns have neither a position nor a region` });
  return findings;
}

// Stable hue per region name, shared by the 3D overlay and the panel swatches.
export function regionHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return ((((hash & 0xffff) / 0xffff) * 0.87 + 0.18) % 1.0);
}
