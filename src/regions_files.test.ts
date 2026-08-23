// node src/regions_files.test.ts — patchers against the real LSB files, not fixtures.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parseMobsYaml, parseRegionsYaml, patchMobsYaml, patchRegionsYaml } from "./regions.ts";
import type { RegionSet } from "./regions.ts";

const dir = "public/zonedata/west_ronfaure";
const regionsYaml = readFileSync(`${dir}/regions.yaml`, "utf8");
const mobsYaml = readFileSync(`${dir}/mobs.yaml`, "utf8");

const regions: RegionSet = {
  rabbit_field: {
    rings: [[[-317.41, -52.49, 308.69], [-290.11, -52.31, 283.01], [-285.31, -51.88, 279.85]]],
  },
};
const added = { "17186822": "rabbit_field", "17186823": "rabbit_field" };

// --- regions.yaml ---
// the file as LSB wrote it has to survive a read and a rewrite untouched
const asIs = parseRegionsYaml(regionsYaml);
assert.ok(asIs.e_46?.rings[0].length > 3, "the region LSB ships parses");
assert.strictEqual(patchRegionsYaml(regionsYaml, asIs).trimEnd(), regionsYaml.trimEnd(), "rewriting it changes nothing");

const regionsOut = patchRegionsYaml(regionsYaml, regions);
assert.deepStrictEqual(parseRegionsYaml(regionsOut), regions, "regions round-trip");
assert.strictEqual(patchRegionsYaml(regionsOut, regions), regionsOut, "idempotent");
assert.ok(regionsOut.startsWith("# yaml-language-server:"), "the schema header survives");

// --- mobs.yaml ---
const before = parseMobsYaml(mobsYaml);
const positions = Object.fromEntries(before.filter(s => s.at).map(s => [s.id, s.at!]));
// the file already places a dozen spawns by region; keeping those is what leaves it unchanged
const assign = { ...Object.fromEntries(before.filter(s => s.region).map(s => [s.id, s.region!])), ...added };
assert.ok(Object.keys(assign).length > Object.keys(added).length, "the fixture has regions of its own");
const mobsOut = patchMobsYaml(mobsYaml, assign, positions);
assert.strictEqual(patchMobsYaml(mobsOut, assign, positions), mobsOut, "idempotent");
assert.strictEqual(
  mobsOut.split("\n").length,
  mobsYaml.split("\n").length,
  "a region line replaces the at: line one for one",
);
assert.strictEqual(
  (mobsOut.match(/^ {4}at:/gm) ?? []).length,
  (mobsYaml.match(/^ {4}at:/gm) ?? []).length - Object.keys(added).length,
  "exactly the assigned spawns lost their at:",
);

const spawns = parseMobsYaml(mobsOut);
assert.strictEqual(spawns.find(s => s.id === "17186822")?.region, "rabbit_field");
assert.strictEqual(spawns.find(s => s.id === "17186822")?.at, undefined, "assigned spawn has no fixed point");
assert.strictEqual(spawns.find(s => s.id === "17186824")?.region, undefined);
assert.deepStrictEqual(spawns.find(s => s.id === "17186824")?.at?.length, 4, "untouched spawns keep theirs");
assert.strictEqual(spawns.length, 602, "every spawn still parses");
// taking the two new assignments back off has to give the file back byte for byte
const asFound = Object.fromEntries(before.filter(s => s.region).map(s => [s.id, s.region!]));
assert.strictEqual(patchMobsYaml(mobsOut, asFound, positions), mobsYaml, "unassigning restores the original file");

console.log("ok");
