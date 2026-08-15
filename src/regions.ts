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

/** Floors are 10+ yalms apart, so anything this close to the nearest one counts as the same floor. */
const SAME_FLOOR = 5;

/**
 * Region at a point: horizontal containment, then the nearest floor, and among regions sharing that
 * floor the smallest one. Smallest-wins is what makes a region nested inside another clickable at
 * all, since the bigger one covers every point the smaller one does.
 */
export function regionAt(regions: RegionSet, x: number, z: number, y: number): string | null {
  const over = Object.entries(regions)
    .filter(([, r]) => containsXZ(r, x, z))
    .map(([name, r]) => ({ name, dy: Math.abs(floorYAt(r, x, z) - y), span: spanXZ(r) }));
  if (!over.length) return null;

  const nearest = Math.min(...over.map(c => c.dy));
  return over
    .filter(c => c.dy <= nearest + SAME_FLOOR)
    .reduce((a, b) => (a.span <= b.span ? a : b))
    .name;
}

/**
 * Visvalingam-Whyatt: repeatedly drop the vertex whose triangle with its neighbours is smallest,
 * until every remaining one covers more than `minArea` square yalms. Keeps the shape's silhouette
 * where a distance-based filter would flatten curves.
 */
export function simplifyRing(ring: Ring, minArea = 4, keep = 3): Ring {
  // ponytail: recomputes areas each pass instead of keeping a heap, fine for a few hundred vertices.
  const out = ring.slice();
  const areaAt = (i: number) => {
    const [ax, , az] = out[(i - 1 + out.length) % out.length];
    const [bx, , bz] = out[i];
    const [cx, , cz] = out[(i + 1) % out.length];
    return Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
  };
  while (out.length > Math.max(3, keep)) {
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

export interface TrailPoint {
  x: number;
  y: number;
  z: number;
}

// Positive for an outline, negative for a hole, given the edge order emitted below.
const signedArea = (ring: Ring) => {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a[0] * b[2] - b[0] * a[2];
  }
  return sum / 2;
};

/**
 * Builds regions covering a set of roam points: rasterise onto a grid, grow by one cell so gaps
 * between samples close, then trace the outline of the occupied cells. A raster follows concave
 * shapes and yields holes for free, which no hull can do. Vertex heights come from the points
 * themselves, so each polygon lands on the floor the mobs were standing on.
 *
 * One region per connected cluster, biggest first: mobs of a kind often live in several separate
 * camps, and a single polygon around all of them would cover everything in between.
 */
export function regionsFromPoints(points: TrailPoint[], cell = 6, close = 2): Region[] {
  if (points.length < 3) return [];

  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }

  const pad = close + 3; // keeps the grown shape clear of the grid border
  const w = Math.ceil((maxX - minX) / cell) + pad * 2 + 1;
  const h = Math.ceil((maxZ - minZ) / cell) + pad * 2 + 1;
  const key = (x: number, z: number) => z * w + x;

  const heights = new Map<number, [number, number]>(); // cell -> [y sum, count]
  const filled = new Set<number>();
  for (const p of points) {
    const k = key(Math.floor((p.x - minX) / cell) + pad, Math.floor((p.z - minZ) / cell) + pad);
    filled.add(k);
    const acc = heights.get(k);
    if (acc) (acc[0] += p.y, acc[1]++);
    else heights.set(k, [p.y, 1]);
  }

  const dilate = (src: Set<number>, by: number) => {
    let out = src;
    for (let step = 0; step < by; step++) {
      const next = new Set(out);
      for (const k of out) {
        const x = k % w;
        const z = (k - x) / w;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) next.add(key(x + dx, z + dz));
        }
      }
      out = next;
    }
    return out;
  };
  const erode = (src: Set<number>, by: number) => {
    let out = src;
    for (let step = 0; step < by; step++) {
      const next = new Set<number>();
      for (const k of out) {
        const x = k % w;
        const z = (k - x) / w;
        let solid = true;
        for (let dz = -1; dz <= 1 && solid; dz++) {
          for (let dx = -1; dx <= 1 && solid; dx++) solid = out.has(key(x + dx, z + dz));
        }
        if (solid) next.add(k);
      }
      out = next;
    }
    return out;
  };

  // Close the shape (grow then shrink) so gaps between samples and between nearby camps join up
  // without inflating the outline, then grow once more so every sampled point sits inside it.
  const grown = dilate(erode(dilate(filled, close + 1), close), 1);

  // Every cell edge with no occupied neighbour is a boundary edge. Shared edges cancel out, so
  // what remains chains into closed loops: the outline plus any holes.
  // ponytail: a corner where two loops pinch diagonally would collide in this map. Growing by a
  // full 8-neighbourhood fills those, so it cannot happen from this pipeline's own output.
  const corner = (x: number, z: number) => z * (w + 1) + x;
  const edges = new Map<number, number>();
  for (const k of grown) {
    const x = k % w;
    const z = (k - x) / w;
    if (!grown.has(key(x, z - 1))) edges.set(corner(x, z), corner(x + 1, z));
    if (!grown.has(key(x + 1, z))) edges.set(corner(x + 1, z), corner(x + 1, z + 1));
    if (!grown.has(key(x, z + 1))) edges.set(corner(x + 1, z + 1), corner(x, z + 1));
    if (!grown.has(key(x - 1, z))) edges.set(corner(x, z + 1), corner(x, z));
  }

  // Height at a corner: whichever of the four cells touching it were actually visited, widening
  // the search a little because the boundary sits on grown cells rather than sampled ones.
  const fallback = points.reduce((s, p) => s + p.y, 0) / points.length;
  const heightAt = (x: number, z: number) => {
    for (let radius = 1; radius <= 3; radius++) {
      let sum = 0;
      let n = 0;
      for (let dz = -radius; dz < radius; dz++) {
        for (let dx = -radius; dx < radius; dx++) {
          const acc = heights.get(key(x + dx, z + dz));
          if (acc) (sum += acc[0], n += acc[1]);
        }
      }
      if (n) return sum / n;
    }
    return fallback;
  };

  const rings: Ring[] = [];
  while (edges.size) {
    const start = edges.keys().next().value as number;
    const ring: Ring = [];
    let at = start;
    while (true) {
      const next = edges.get(at);
      if (next === undefined) break;
      edges.delete(at);
      const x = at % (w + 1);
      const z = (at - x) / (w + 1);
      ring.push([minX + (x - pad) * cell, heightAt(x, z), minZ + (z - pad) * cell]);
      at = next;
      if (at === start) break;
    }
    if (ring.length >= 4) rings.push(ring);
  }

  // Winding tells outlines from holes, so separate clusters stay separate regions instead of being
  // mistaken for holes in the biggest one. Specks a few cells across are sampling noise.
  const speck = cell * cell * 4;
  const outlines = rings.filter(r => signedArea(r) >= speck).sort((a, b) => signedArea(b) - signedArea(a));
  const holes = rings.filter(r => -signedArea(r) >= speck);
  // Boundary staircases carry no information, and cutting them costs no coverage in practice.
  const smooth = (r: Ring) => simplifyRing(r, cell * cell * 4);

  return outlines.map(outline => ({
    rings: [smooth(outline), ...holes.filter(h => inRingXZ(outline, h[0][0], h[0][2])).map(smooth)],
  }));
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
