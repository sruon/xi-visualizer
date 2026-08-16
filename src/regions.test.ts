// node src/regions.test.ts
import assert from "node:assert";
import {
  containsXZ,
  diffRegions,
  emitRegionsBlock,
  floorYAt,
  parseMobsYaml,
  parseZoneYaml,
  patchMobsYaml,
  patchZoneYaml,
  regionArea,
  regionAt,
  regionsFromPoints,
  selfIntersects,
  simplifyRing,
  validate,
  zoneOfMobId,
} from "./regions.ts";
import type { RegionSet, Ring, TrailPoint, ZoneSide } from "./regions.ts";

// Two stacked floors sharing the same footprint, ground floor has a hole.
const regions: RegionSet = {
  f1_hall: {
    rings: [
      [[0, -50, 0], [10, -50, 0], [10, -50, 10], [0, -50, 10]],
      [[4, -50, 4], [6, -50, 4], [6, -50, 6], [4, -50, 6]],
    ],
  },
  f2_hall: { rings: [[[0, -70, 0], [10, -70, 0], [10, -70, 10], [0, -70, 10]]] },
};

// --- geometry ---
assert.ok(containsXZ(regions.f1_hall, 1, 1), "inside outline");
assert.ok(!containsXZ(regions.f1_hall, 5, 5), "inside hole is outside");
assert.ok(!containsXZ(regions.f1_hall, 20, 5), "outside outline");
assert.strictEqual(floorYAt(regions.f1_hall, 1, 1), -50);
assert.strictEqual(regionAt(regions, 1, 1, -49), "f1_hall", "nearest floor picks the ground floor");
assert.strictEqual(regionAt(regions, 1, 1, -69), "f2_hall", "nearest floor picks the upper floor");
assert.strictEqual(regionAt(regions, 99, 99, -50), null, "outside everything");

// a small region nested in a bigger one on the same floor has to win, or it can never be clicked
const nested: RegionSet = {
  big: { rings: [[[0, -50, 0], [40, -50, 0], [40, -50, 40], [0, -50, 40]]] },
  small: { rings: [[[10, -50.4, 10], [20, -50.4, 10], [20, -50.4, 20], [10, -50.4, 20]]] },
};
assert.strictEqual(regionAt(nested, 15, 15, -50), "small", "nested region wins inside it");
assert.strictEqual(regionAt(nested, 35, 35, -50), "big", "outside the nested one, the big one wins");
assert.ok(selfIntersects([[0, 0, 0], [10, 0, 10], [10, 0, 0], [0, 0, 10]]), "bowtie");

// simplify drops near-collinear filler, keeps the corners, and never destroys the shape
const noisy = [[0, 0, 0], [5, 0, 0.1], [10, 0, 0], [10, 0, 10], [5, 0, 10.1], [0, 0, 10]] as Ring;
assert.deepStrictEqual(simplifyRing(noisy), [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]], "collinear filler removed");
assert.strictEqual(simplifyRing(noisy, 1000).length, 3, "never goes below a triangle");
assert.strictEqual(simplifyRing(regions.f1_hall.rings[0]).length, 4, "a clean square is left alone");
assert.ok(!selfIntersects(regions.f1_hall.rings[0]), "square is clean");

// --- building a region out of roam points ---
const blob: TrailPoint[] = [];
for (let x = 0; x <= 40; x += 2) {
  for (let z = 0; z <= 40; z += 2) blob.push({ x, y: -50, z });
}
const built = regionsFromPoints(blob)[0];
assert.strictEqual(regionsFromPoints(blob).length, 1, "one cluster, one region");
assert.strictEqual(built.rings.length, 1, "a solid blob has no holes");
assert.ok(built.rings[0].length >= 4 && built.rings[0].length <= 12, `outline stays simple, got ${built.rings[0].length}`);
assert.ok(built.rings[0].every(v => Math.abs(v[1] + 50) < 0.01), "vertex heights come from the points");
const xs = built.rings[0].map(v => v[0]);
const zs = built.rings[0].map(v => v[2]);
assert.ok(Math.min(...xs) <= 0 && Math.max(...xs) >= 40, "outline covers the points in x");
assert.ok(Math.min(...zs) <= 0 && Math.max(...zs) >= 40, "outline covers the points in z");
assert.ok(blob.every(p => containsXZ(built, p.x, p.z)), "every point it was built from is inside it");

// an annulus of points has to come out as an outline plus a hole
const donut: TrailPoint[] = [];
for (let a = 0; a < 360; a += 2) {
  for (let r = 34; r <= 60; r += 2) {
    donut.push({ x: Math.cos((a * Math.PI) / 180) * r, y: -20, z: Math.sin((a * Math.PI) / 180) * r });
  }
}
const ring = regionsFromPoints(donut)[0];
assert.strictEqual(ring.rings.length, 2, "annulus keeps its hole");
assert.ok(!containsXZ(ring, 0, 0), "the middle of the donut is not inside");
assert.ok(containsXZ(ring, 45, 0), "the band itself is inside");
assert.deepStrictEqual(regionsFromPoints([{ x: 0, y: 0, z: 0 }]), [], "not enough points to build anything");

// two camps have to come out as two regions, not one region with the other punched out of it
const camps: TrailPoint[] = [];
for (let x = 0; x <= 30; x += 2) for (let z = 0; z <= 30; z += 2) camps.push({ x, y: -50, z });
for (let x = 200; x <= 240; x += 2) for (let z = 0; z <= 30; z += 2) camps.push({ x, y: -50, z });
const split = regionsFromPoints(camps);
assert.strictEqual(split.length, 2, "two clusters, two regions");
assert.ok(camps.every(p => split.some(r => containsXZ(r, p.x, p.z))), "every point lands in one of them");

// --- zone.yaml round trip and patching ---
const zoneYaml = `# yaml-language-server: $schema=../../schemas/zone.schema.json
type: [outdoors]

zonelines:

  z2s0:
    from:  [-119.065, -65.707, 280.921]
    to:    southern_san_doria
`;
const patched = patchZoneYaml(zoneYaml, regions);
assert.ok(patched.startsWith(zoneYaml.trimEnd()), "existing zone.yaml content survives verbatim");
assert.deepStrictEqual(parseZoneYaml(patched), regions, "regions round-trip through zone.yaml");
assert.strictEqual(patchZoneYaml(patched, regions), patched, "patching is idempotent");
assert.ok(!patchZoneYaml(patched, {}).includes("regions:"), "empty region set removes the block");
assert.match(emitRegionsBlock(regions), /^  f1_hall:$/m);
assert.ok(emitRegionsBlock(regions).indexOf("f1_hall") < emitRegionsBlock(regions).indexOf("f2_hall"), "sorted by name");

// --- mobs.yaml patching ---
const mobsYaml = `# yaml-language-server: $schema=../../schemas/mobs.schema.json
#  spawns:   <- generated reference comment, must not be treated as a section

templates:

  Wild_Rabbit:
    id: 5421

spawns:
  17186822:
    template: Wild_Rabbit
    at:       [-317.406, -52.494, 308.691, 127]
    level:    [1, 1]
  17186823:
    template: Tunnel_Worm
    at:       [1.000, 2.000, 3.000]
    level:    [1, 1]
    region:   stale_region

slots:
  - members:
      17186822: {} # Wild_Rabbit
`;
const positions = Object.fromEntries(parseMobsYaml(mobsYaml).filter(s => s.at).map(s => [s.id, s.at!]));
const assigned = patchMobsYaml(mobsYaml, { "17186822": "f1_hall" }, positions);
assert.match(assigned, /template: Wild_Rabbit\n {4}level: {4}\[1, 1\]\n {4}region: {3}f1_hall\n/, "region replaces the fixed spawn point");
assert.ok(!assigned.includes("-317.406"), "at: removed once a region places it");
assert.ok(!assigned.includes("stale_region"), "assignment dropped when no longer assigned");
assert.ok(assigned.includes("templates:\n\n  Wild_Rabbit:"), "templates untouched");
assert.ok(assigned.includes("slots:\n  - members:\n      17186822: {} # Wild_Rabbit\n"), "later sections untouched");
assert.strictEqual(patchMobsYaml(assigned, { "17186822": "f1_hall" }, positions), assigned, "patching is idempotent");

// unassigning puts the coordinates back exactly as they were
assert.strictEqual(patchMobsYaml(assigned, {}, positions), mobsYaml.replace("    region:   stale_region\n", ""), "at: restored on unassign");

const spawns = parseMobsYaml(assigned);
assert.deepStrictEqual(spawns[0], { id: "17186822", name: "Wild_Rabbit", x: 0, y: 0, z: 0, at: undefined, region: "f1_hall" });
assert.deepStrictEqual(spawns[1].at, [1, 2, 3]);
assert.strictEqual(spawns[1].region, undefined);
assert.strictEqual(zoneOfMobId("17186822"), 100); // West Ronfaure

// --- diffing two versions of a zone ---
const before: ZoneSide = {
  regions: {
    kept: { rings: [[[0, -50, 0], [10, -50, 0], [10, -50, 10], [0, -50, 10]]] },
    grown: { rings: [[[0, -50, 0], [10, -50, 0], [10, -50, 10], [0, -50, 10]]] },
    gone: { rings: [[[50, -50, 50], [60, -50, 50], [60, -50, 60], [50, -50, 60]]] },
  },
  spawns: [
    { id: "1", name: "Rabbit", x: 1, y: -50, z: 1, region: "kept" },
    { id: "2", name: "Bat", x: 2, y: -50, z: 2, region: "gone" },
    { id: "3", name: "Worm", x: 3, y: -50, z: 3, at: [3, -50, 3] },
  ],
};
const after: ZoneSide = {
  regions: {
    kept: { rings: [[[0, -50, 0], [10, -50, 0], [10, -50, 10], [0, -50, 10]]] },
    grown: { rings: [[[0, -50, 0], [20, -50, 0], [20, -50, 10], [0, -50, 10]]] },
    fresh: { rings: [[[70, -50, 70], [80, -50, 70], [80, -50, 80]]] },
  },
  spawns: [
    { id: "1", name: "Rabbit", x: 1, y: -50, z: 1, region: "kept" },
    { id: "2", name: "Bat", x: 2, y: -50, z: 2, region: "grown" },
    { id: "3", name: "Worm", x: 3, y: -50, z: 3, region: "fresh" },
  ],
};
const delta = diffRegions(before, after);
assert.deepStrictEqual(delta.added, ["fresh"]);
assert.deepStrictEqual(delta.removed, ["gone"]);
assert.deepStrictEqual(delta.unchanged, ["kept"]);
assert.deepStrictEqual(delta.reshaped, [{ name: "grown", fromVertices: 4, toVertices: 4, areaRatio: 2 }]);
assert.deepStrictEqual(delta.moved, [
  { id: "2", name: "Bat", from: "gone", to: "grown" },
  { id: "3", name: "Worm", from: undefined, to: "fresh" },
]);
assert.deepStrictEqual([delta.addedSpawns, delta.removedSpawns], [[], []]);
assert.deepStrictEqual(diffRegions(after, after).reshaped, [], "a side against itself has no changes");
assert.strictEqual(regionArea(before.regions.kept), 100);
assert.strictEqual(regionArea(regions.f1_hall), 96, "holes come out of the area");

// --- review ---
const findings = validate(
  { ...regions, empty_room: { rings: [[[0, 0, 0], [1, 0, 0]]] } },
  [
    { id: "1", name: "Rabbit", x: 1, y: -49, z: 1, at: [1, -49, 1] },
    { id: "2", name: "Bat", x: 1, y: -69, z: 1, at: [1, -69, 1] },
    { id: "3", name: "Worm", x: 99, y: -50, z: 99, at: [99, -50, 99] },
    { id: "4", name: "Crab", x: 1, y: -50, z: 1, at: [1, -50, 1] },
    { id: "5", name: "Hare", x: 2, y: -50, z: 2, at: [2, -50, 2] },
    { id: "6", name: "Ghost", x: 0, y: 0, z: 0 },
  ],
  { "1": "f1_hall", "2": "f1_hall", "3": "f1_hall", "4": "ghost_region" },
);
const has = (t: string) => findings.some(f => f.text.includes(t));
assert.ok(has("only 2 vertices"), "degenerate ring");
assert.ok(has("no spawns assigned"), "unused region");
assert.ok(has("nearer f2_hall's floor"), "wrong floor");
assert.ok(has("stands outside"), "assigned but outside");
assert.ok(has("undefined region ghost_region"), "dangling reference");
assert.ok(has("2 spawns unassigned"), "unassigned tally");
assert.ok(has("1 spawns have neither a position nor a region"), "spawn left with nowhere to go");

console.log("ok");
