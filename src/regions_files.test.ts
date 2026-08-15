// node src/regions_files.test.ts — patchers against the real LSB files, not fixtures.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parseMobsYaml, parseZoneYaml, patchMobsYaml, patchZoneYaml } from "./regions.ts";
import type { RegionSet } from "./regions.ts";

const dir = "public/zonedata/west_ronfaure";
const zoneYaml = readFileSync(`${dir}/zone.yaml`, "utf8");
const mobsYaml = readFileSync(`${dir}/mobs.yaml`, "utf8");

const regions: RegionSet = {
  rabbit_field: {
    rings: [[[-317.41, -52.49, 308.69], [-290.11, -52.31, 283.01], [-285.31, -51.88, 279.85]]],
  },
};
const assign = { "17186822": "rabbit_field", "17186823": "rabbit_field" };

// --- zone.yaml ---
const zoneOut = patchZoneYaml(zoneYaml, regions);
assert.deepStrictEqual(parseZoneYaml(zoneOut), regions, "regions round-trip");
assert.strictEqual(patchZoneYaml(zoneOut, regions), zoneOut, "idempotent");
// everything that was there before is still there, in order
const kept = zoneOut.split("\n");
let cursor = 0;
for (const line of zoneYaml.split("\n")) {
  const found = kept.indexOf(line, cursor);
  assert.notStrictEqual(found, -1, `zone.yaml line vanished: ${line}`);
  cursor = found;
}
assert.strictEqual(patchZoneYaml(zoneOut, {}).trimEnd(), zoneYaml.trimEnd(), "removing regions restores the original file");

// --- mobs.yaml ---
const positions = Object.fromEntries(parseMobsYaml(mobsYaml).filter(s => s.at).map(s => [s.id, s.at!]));
const mobsOut = patchMobsYaml(mobsYaml, assign, positions);
assert.strictEqual(patchMobsYaml(mobsOut, assign, positions), mobsOut, "idempotent");
assert.strictEqual(
  mobsOut.split("\n").length,
  mobsYaml.split("\n").length,
  "a region line replaces the at: line one for one",
);
assert.strictEqual(
  (mobsOut.match(/^ {4}at:/gm) ?? []).length,
  (mobsYaml.match(/^ {4}at:/gm) ?? []).length - Object.keys(assign).length,
  "exactly the assigned spawns lost their at:",
);

const spawns = parseMobsYaml(mobsOut);
assert.strictEqual(spawns.find(s => s.id === "17186822")?.region, "rabbit_field");
assert.strictEqual(spawns.find(s => s.id === "17186822")?.at, undefined, "assigned spawn has no fixed point");
assert.strictEqual(spawns.find(s => s.id === "17186824")?.region, undefined);
assert.deepStrictEqual(spawns.find(s => s.id === "17186824")?.at?.length, 4, "untouched spawns keep theirs");
assert.strictEqual(spawns.length, 602, "every spawn still parses");
assert.strictEqual(patchMobsYaml(mobsOut, {}, positions), mobsYaml, "unassigning everything restores the original file");

console.log("ok");
