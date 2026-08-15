// node src/regions.test.ts
import assert from "node:assert";
import {
  containsXZ,
  emitRegionsBlock,
  floorYAt,
  parseMobsYaml,
  parseZoneYaml,
  patchMobsYaml,
  patchZoneYaml,
  regionAt,
  selfIntersects,
  simplifyRing,
  validate,
  zoneOfMobId,
} from "./regions.ts";
import type { RegionSet, Ring } from "./regions.ts";

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
assert.ok(selfIntersects([[0, 0, 0], [10, 0, 10], [10, 0, 0], [0, 0, 10]]), "bowtie");

// simplify drops near-collinear filler, keeps the corners, and never destroys the shape
const noisy = [[0, 0, 0], [5, 0, 0.1], [10, 0, 0], [10, 0, 10], [5, 0, 10.1], [0, 0, 10]] as Ring;
assert.deepStrictEqual(simplifyRing(noisy), [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]], "collinear filler removed");
assert.strictEqual(simplifyRing(noisy, 1000).length, 3, "never goes below a triangle");
assert.strictEqual(simplifyRing(regions.f1_hall.rings[0]).length, 4, "a clean square is left alone");
assert.ok(!selfIntersects(regions.f1_hall.rings[0]), "square is clean");

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
