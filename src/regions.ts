import { load } from "js-yaml";
import { difference, union } from "polyclip-ts";
import type { Geom } from "polyclip-ts";

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
  /** Raw `at:` as written, [x, y, z, rot?]. Absent once a region or a path took over placement. */
  at?: number[];
  region?: string;
  /** Patrol route. The mob spawns on the first leg, so this replaces `at:` too. */
  path?: Vertex[];
  /** Whether the route closes back on itself. Absent means true. */
  loop?: boolean;
}

/** A spawn is placed by exactly one of these: a fixed point, a region, or a patrol route. */
export interface Patrol {
  legs: Vertex[];
  loop?: boolean;
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
    path: Array.isArray(s?.path) ? s.path.map((p: any) => [Number(p[0]), Number(p[1]), Number(p[2])] as Vertex) : undefined,
    loop: typeof s?.loop === "boolean" ? s.loop : undefined,
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
 * Rewrites how each spawn in mobs.yaml is placed: a `region:`, a `path:` of legs, or the fixed
 * `at:` point it came with. Exactly one of the three survives per entry, and `at:` is restored from
 * `positions` when a spawn goes back to being placed by hand. Line surgery on purpose: the file is
 * mostly a generated comment header plus templates we must not reformat.
 */
export function patchMobsYaml(
  text: string,
  assign: Record<string, string>,
  positions: Record<string, number[]> = {},
  paths: Record<string, Patrol> = {},
): string {
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
    const patrol = region ? undefined : paths[id];
    const placed = !!region || !!patrol;

    // Drop whatever placement the file had: the keys, plus the list items under `path:`.
    const keep: string[] = [];
    let inPath = false;
    for (const line of body) {
      if (/^\s+path:/.test(line)) {
        inPath = true;
        continue;
      }
      if (inPath) {
        if (/^\s+-/.test(line)) continue;
        inPath = false;
      }
      if (/^\s+(region|loop):/.test(line)) continue;
      if (placed && /^\s+at:/.test(line)) continue;
      keep.push(line);
    }

    if (!placed && !keep.some(l => /^\s+at:/.test(l)) && positions[id]) {
      const at = positions[id].map((n, i) => (i < 3 ? n.toFixed(3) : String(n))).join(", ");
      const after = keep.findLastIndex(l => /^\s+(template|script):/.test(l));
      keep.splice(after + 1, 0, `    at:       [${at}]`);
    }

    let last = keep.length;
    while (last > 0 && keep[last - 1].trim() === "") last--;
    if (region) keep.splice(last, 0, `    region:   ${region}`);
    else if (patrol) {
      const lines = [`    path:`, ...patrol.legs.map(v => `      - [${v.map(n => n.toFixed(3)).join(", ")}]`)];
      if (patrol.loop === false) lines.unshift(`    loop:     false`);
      keep.splice(last, 0, ...lines);
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
  /** Capture time in seconds. Absent means the samples are assumed to be one unbroken run. */
  t?: number;
}

/** Perpendicular distance in x/z from p to the segment ab. */
function perpDistance(a: Vertex, b: Vertex, p: Vertex): number {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[2] - (a[2] + t * dz));
}

/**
 * Douglas-Peucker for an open line: the ends are fixed, and a point survives when dropping it would
 * pull the line more than `tolerance` yalms away from it. `max` legs is a ceiling, met by loosening
 * the tolerance until it fits.
 *
 * Not Visvalingam, which is what regions use: a patrol that walks out and back doubles over itself,
 * and the triangle at the turn is degenerate, so area ranks the one vertex that defines the route as
 * the most disposable point on it. Removing it collapses the whole excursion. Perpendicular distance
 * ranks that same vertex first instead, which is the only correct answer for a route.
 */
export function simplifyLine(points: Vertex[], tolerance = 4, max = Infinity): Vertex[] {
  if (points.length <= 2) return points.slice();

  const thin = (limit: number) => {
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const spans: [number, number][] = [[0, points.length - 1]];
    while (spans.length) {
      const [from, to] = spans.pop()!;
      let far = -1;
      let worst = limit;
      for (let i = from + 1; i < to; i++) {
        const d = perpDistance(points[from], points[to], points[i]);
        if (d > worst) {
          worst = d;
          far = i;
        }
      }
      if (far < 0) continue;
      keep[far] = 1;
      spans.push([from, far], [far, to]);
    }
    return points.filter((_, i) => keep[i]);
  };

  let limit = tolerance;
  let out = thin(limit);
  while (out.length > max) out = thin(limit *= 1.5);
  return out;
}

export interface TracedRoute {
  legs: Vertex[];
  /** Fraction of the trail that sits on the route. A mob walking a beat scores near 1. */
  coverage: number;
}

const trailExtent = (run: TrailPoint[]) => {
  const xs = run.map(p => p.x);
  const zs = run.map(p => p.z);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
};

/**
 * The trail split into unbroken captures. Samples arrive a few seconds apart while someone is
 * watching the mob and then stop for minutes, so consecutive entries in the file are not
 * necessarily consecutive positions: a leg drawn across that boundary crosses ground nobody saw
 * the mob walk. Rates differ per mob, from four seconds to well over a minute, so the threshold
 * comes from the mob's own median rather than a fixed number of seconds.
 */
function capturesOf(points: TrailPoint[]): TrailPoint[][] {
  const steps: number[] = [];
  for (let i = 1; i < points.length; i++) steps.push((points[i].t ?? 0) - (points[i - 1].t ?? 0));
  const typical = [...steps].sort((a, b) => a - b)[steps.length >> 1] || 0;
  const maxStep = Math.max(20, typical * 6);

  const out: TrailPoint[][] = [];
  let run: TrailPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const jumped = points[i].t === undefined
      ? (points[i].x - points[i - 1].x) ** 2 + (points[i].z - points[i - 1].z) ** 2 > 50 * 50
      : steps[i - 1] > maxStep;
    if (jumped) {
      out.push(run);
      run = [];
    }
    run.push(points[i]);
  }
  out.push(run);
  return out.filter(r => r.length >= 8);
}

/**
 * Stretches of one capture that might each be a circuit: from a point until the mob has gone well
 * away and come back near it.
 *
 * On its own this cuts the circuit in the wrong place. A route that passes close to its own start
 * partway round gets split there, and the piece past the split is missing from every lap, so the
 * traced route comes up short by the same section every time. Hence the periods below.
 */
function lapsOf(run: TrailPoint[], close: number): TrailPoint[][] {
  const flat = (a: TrailPoint, b: TrailPoint) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
  const out: TrailPoint[][] = [];
  let from = 0;
  let away = false;
  for (let i = 1; i < run.length; i++) {
    const d2 = flat(run[i], run[from]);
    if (!away) away = d2 > (close * 3) ** 2;
    else if (d2 < close * close) {
      out.push(run.slice(from, i + 1));
      from = i;
      away = false;
    }
  }
  return out.filter(lap => lap.length >= 4 && trailExtent(lap) >= close * 4);
}

/**
 * Windows of one circuit each, found as the repeat period of a capture: the sample lag at which the
 * mob is most often back where it was. This finds the whole circuit including any spur, which the
 * laps above can miss, and it costs one pass per candidate lag.
 *
 * The median, not the mean, because one excursion would otherwise drag every lag's score alike.
 */
function periodWindows(run: TrailPoint[], close: number): TrailPoint[][] {
  const n = run.length;
  const maxLag = Math.min(800, Math.floor(n / 3));
  if (maxLag < 10) return [];

  const scored: { lag: number; offset: number; }[] = [];
  for (let lag = 10; lag <= maxLag; lag++) {
    const offsets: number[] = [];
    const step = Math.max(1, Math.floor((n - lag) / 120));
    for (let i = 0; i < n - lag; i += step) {
      offsets.push(Math.hypot(run[i].x - run[i + lag].x, run[i].z - run[i + lag].z));
    }
    offsets.sort((a, b) => a - b);
    scored.push({ lag, offset: offsets[offsets.length >> 1] });
  }
  scored.sort((a, b) => a.offset - b.offset);

  const out: TrailPoint[][] = [];
  for (const { lag } of scored.slice(0, 4)) {
    for (const at of [0, 0.25, 0.5, 0.75]) {
      const window = closedCircuit(run, Math.floor((n - lag - 1) * at), lag, close);
      if (window) out.push(window);
    }
  }
  return out;
}

/**
 * The samples from a start index up to wherever the mob next comes back to that spot, give or take
 * a quarter of the lag. A lag is only a rough period, so the window it cuts does not land back
 * exactly where it started, and a route whose ends do not meet closes itself with a leg straight
 * across open ground. Nothing near the start means the stretch is not a circuit and holds no route.
 */
function closedCircuit(run: TrailPoint[], from: number, lag: number, close: number): TrailPoint[] | null {
  let end = -1;
  let nearest = (close * 2) ** 2;
  for (let i = Math.floor(from + lag * 0.75); i <= Math.min(from + lag * 1.25, run.length - 1); i++) {
    const d2 = (run[i].x - run[from].x) ** 2 + (run[i].z - run[from].z) ** 2;
    if (d2 < nearest) {
      nearest = d2;
      end = i;
    }
  }
  return end < 0 ? null : run.slice(from, end + 1);
}

/**
 * Traces a patrol route out of a mob's recorded trail: the samples are in capture order, so a route
 * is the points joined up in that order and thinned only enough to be editable. Every candidate
 * circuit is scored by how much of the whole trail lands on it and the best one wins, since a mob
 * walking a beat stays on it while a wanderer leaves most of its trail off to one side. The score
 * comes back with the route, so the caller can say how well it fits rather than implying that a
 * traced route is necessarily a real one.
 */
export function routeFromTrail(points: TrailPoint[], close = 8): TracedRoute | null {
  if (points.length < 30) return null;

  const stride = Math.max(1, Math.floor(points.length / 400));
  const sampled: TrailPoint[] = [];
  for (let i = 0; i < points.length; i += stride) sampled.push(points[i]);

  const coverageOf = (legs: Vertex[]) => sampled.filter(p => distanceToRoute(legs, p) <= close * 1.5).length / sampled.length;

  // A route may only run where the mob was seen walking. A candidate that spans a break in the
  // capture is fine when the mob picked its beat back up where it left off, and not fine when it
  // came back somewhere else: the difference is whether the leg between them covers ground that has
  // samples on it, which is what this checks, rather than whether a break is in the window at all.
  const onGround = (legs: Vertex[]) =>
    legs.every((v, i) => {
      const next = legs[(i + 1) % legs.length];
      return [0.25, 0.5, 0.75].every(t => {
        const x = v[0] + (next[0] - v[0]) * t;
        const z = v[2] + (next[2] - v[2]) * t;
        return sampled.some(p => (p.x - x) ** 2 + (p.z - z) ** 2 <= (close * 2) ** 2);
      });
    });

  const candidates: TrailPoint[][] = [];
  for (const run of [...capturesOf(points), points]) {
    // The capture itself, for when the mob got round once before anyone lost sight of it. Whether
    // that is a circuit or one aimless walk is not decided here: coverage below settles it, since a
    // beat the mob repeats explains the rest of the trail and a one-off walk does not.
    const whole = closedCircuit(run, 0, run.length - 1, close);
    if (whole) candidates.push(whole);
    candidates.push(...lapsOf(run, close), ...periodWindows(run, close));
  }

  let best: TracedRoute | null = null;
  for (const candidate of candidates) {
    if (trailExtent(candidate) < close * 5) continue; // a mob milling about on the spot has no route
    const legs = simplifyLine(candidate.map(p => [p.x, p.y, p.z] as Vertex), 2, 64);
    if (legs.length < 3 || !onGround(legs)) continue;
    const coverage = coverageOf(legs);
    if (!best || coverage > best.coverage) best = { legs, coverage };
  }
  // Below this the trail is a blob the route happens to cross, not a beat the mob walks.
  return best && best.coverage >= 0.6 ? best : null;
}

/** Shortest distance in x/z from a point to a closed route. */
function distanceToRoute(legs: Vertex[], p: TrailPoint): number {
  let best = Infinity;
  for (let i = 0; i < legs.length; i++) {
    const [ax, , az] = legs[i];
    const [bx, , bz] = legs[(i + 1) % legs.length];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (ax + t * dx), p.z - (az + t * dz)));
  }
  return best;
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

/**
 * Rewrites a region as shapes that are actually valid: an outline that crosses itself becomes the
 * pieces it really describes, and the holes are cut out of it rather than merely listed after it.
 * A bowtie is two triangles and not one region, so this returns a list.
 *
 * Dragging a vertex across an edge is all it takes to make a ring that crosses itself, and the
 * review tab could only ever point at one. Clipping is the one piece of geometry here worth handing
 * to a library: the sweep line handling every way edges can meet is not something to hand roll.
 *
 * Heights come back from the nearest original vertex, since the corners the clipper invents where
 * edges cross are new points that no sample ever stood on.
 */
export function repairRegion(r: Region): Region[] {
  const outline = r.rings[0] ?? [];
  if (outline.length < 3) return [];
  const flat = (ring: Ring): Geom => [ring.map(v => [v[0], v[2]] as [number, number])];

  let shape = union(flat(outline));
  const holes = r.rings.slice(1).filter(hole => hole.length >= 3);
  if (holes.length) shape = difference(shape, ...holes.map(flat));

  const known = r.rings.flat();
  const heightAt = (x: number, z: number) => {
    let best = known[0]?.[1] ?? 0;
    let nearest = Infinity;
    for (const v of known) {
      const d = (v[0] - x) ** 2 + (v[2] - z) ** 2;
      if (d < nearest) (nearest = d, best = v[1]);
    }
    return best;
  };

  return shape.map(polygon => ({
    rings: polygon.map(ring => {
      // The clipper repeats the first vertex to close a ring; ours are closed by being rings.
      const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
        ? ring.slice(0, -1)
        : ring;
      return open.map(([x, z]) => [x, heightAt(x, z), z] as Vertex);
    }),
  })).filter(out => (out.rings[0]?.length ?? 0) >= 3);
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

// --- diffing two versions of a zone ---

/** Outline area minus its holes, in square yalms. */
export function regionArea(r: Region): number {
  const outer = Math.abs(signedArea(r.rings[0] ?? []));
  const holes = r.rings.slice(1).reduce((sum, h) => sum + Math.abs(signedArea(h)), 0);
  return Math.max(0, outer - holes);
}

export interface RegionChange {
  name: string;
  fromVertices: number;
  toVertices: number;
  /** head area / base area, so 1.18 means the region grew by 18%. */
  areaRatio: number;
}

export interface SpawnMove {
  id: string;
  name: string;
  from?: string;
  to?: string;
}

export interface RegionsDiff {
  added: string[];
  removed: string[];
  reshaped: RegionChange[];
  unchanged: string[];
  moved: SpawnMove[];
  addedSpawns: string[];
  removedSpawns: string[];
}

export interface ZoneSide {
  regions: RegionSet;
  spawns: Spawn[];
}

/**
 * What changed between two versions of a zone. Shapes are compared through the canonical emitter,
 * so a difference here is a difference that would show up in the file rather than float noise.
 */
export function diffRegions(base: ZoneSide, head: ZoneSide): RegionsDiff {
  const shape = (r: Region) => emitRegionsBlock({ r });
  const names = new Set([...Object.keys(base.regions), ...Object.keys(head.regions)]);

  const diff: RegionsDiff = { added: [], removed: [], reshaped: [], unchanged: [], moved: [], addedSpawns: [], removedSpawns: [] };
  for (const name of [...names].sort()) {
    const before = base.regions[name];
    const after = head.regions[name];
    if (!before) diff.added.push(name);
    else if (!after) diff.removed.push(name);
    else if (shape(before) === shape(after)) diff.unchanged.push(name);
    else {
      diff.reshaped.push({
        name,
        fromVertices: before.rings[0]?.length ?? 0,
        toVertices: after.rings[0]?.length ?? 0,
        areaRatio: regionArea(before) ? regionArea(after) / regionArea(before) : Infinity,
      });
    }
  }

  const baseSpawns = new Map(base.spawns.map(s => [s.id, s]));
  const headSpawns = new Map(head.spawns.map(s => [s.id, s]));
  for (const [id, after] of headSpawns) {
    const before = baseSpawns.get(id);
    if (!before) diff.addedSpawns.push(id);
    else if (before.region !== after.region) diff.moved.push({ id, name: after.name, from: before.region, to: after.region });
  }
  for (const id of baseSpawns.keys()) {
    if (!headSpawns.has(id)) diff.removedSpawns.push(id);
  }
  diff.moved.sort((a, b) => a.name.localeCompare(b.name) || Number(a.id) - Number(b.id));
  return diff;
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
    if (s.path && s.path.length < 2) {
      findings.push({ level: "error", spawnId: s.id, text: `${s.name} has a patrol route with ${s.path.length} legs` });
    }
    if (s.path && assign[s.id]) {
      findings.push({ level: "error", spawnId: s.id, text: `${s.name} has both a region and a patrol route` });
    }
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
  // Informational, not a fault: a mob that stands in one place is placed correctly by a fixed point.
  if (loose.length) findings.push({ level: "info", text: `${loose.length} spawns on a fixed point` });

  // A region or a route replaces `at:`, so a spawn with none has nowhere to be placed. Counted, not
  // listed: zones ship with entries that never had a position, and one line per spawn buries the
  // findings that need acting on.
  const nowhere = loose.filter(s => !s.at && !s.path).length;
  if (nowhere) findings.push({ level: "warn", text: `${nowhere} spawns have no position, region or route` });
  return findings;
}

// Stable hue per region name, shared by the 3D overlay and the panel swatches.
export function regionHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return ((((hash & 0xffff) / 0xffff) * 0.87 + 0.18) % 1.0);
}
