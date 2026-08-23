# Handoff: generate the first spawn regions from roam data

You are writing a **one-shot bootstrap**. It runs once per zone to produce the first set of spawn
regions and spawn→region assignments; from then on humans maintain them in the visualizer's Regions
page (`/regions`). There is no re-run, so nothing needs a "generated" marker — but whatever you emit
is the shape that zone keeps, so it is worth getting right rather than getting quickly.

Read `docs/regions-format.md` first. It is the output contract and explains why the format is what
it is. This document covers the inputs, the recommended algorithm, and the traps.

## Inputs (all verified, paths as of this writing)

**Roam data** — `xi-visualizer/public/pathdata_gz/<Zone_Name>.json.gz`, 161 zones, also served from
`https://f002.backblazeb2.com/file/ffxi-roam-data/<Zone_Name>.json.gz`. Gzipped JSON:

```json
{ "17186822": { "name": "Wild_Rabbit",
                "points": [ {"x": -309.039, "y": -52.231, "z": 311.502, "dir": 155, "t": 1769475983} ] } }
```

Filenames use the zone name with spaces as underscores and ` - ` as `_-_` (`Abyssea_-_Altepa.json.gz`);
`src/data/zones.json` maps zone id → name.

**Zone data** — `lsb/data/zones/<zone>/{regions.yaml,mobs.yaml}` on **`LandSandBoat/server@base`**,
where all 300 zones now live. `regions.yaml` exists only where someone has drawn regions; a zone
without one has none yet.
`mobs.yaml` holds `spawns:` keyed by mobid with `template:`, `at: [x, y, z, rot]`, `level:`.

**How they line up** (measured on west_ronfaure): 602 spawns, 409 of them have roam data (68%), and
**every roam id exists in mobs.yaml** — zero orphans. The ids are the same mobids on both sides, so
no matching heuristics are needed. Zone id from a mobid is `(mobid >> 12) & 0xff`.

## The shape of the problem

Two numbers that should drive your design, both measured on west_ronfaure:

- Median roam trail is **638 points**, max 3,938, min 1.
- A mob wanders a **median of 146 yalms from its spawn point**, up to 234.

So these are not tight circles around spawn points. They are large, overlapping territories, and the
region a mob belongs to is mostly determined by *what kind of mob it is*, not by where its spawn
point happens to sit. Do not build one region per spawn — you would get 400 overlapping blobs.

## Recommended algorithm

Per zone:

1. **Group by template, then by geography.** Take all roam points of every spawn sharing a
   `template:`, then split into connected components (below). One template can have separate
   populations at opposite ends of a zone; those must not become one region spanning both.
2. **Rasterise, don't hull.** Mark a 4-yalm occupancy grid from the roam points, morphologically
   close it (dilate 1–2 cells, then erode) to bridge sampling gaps, and take connected components.
   A convex hull swallows everything a trail bends around; alpha shapes need a tuned parameter per
   zone. A raster is trivially correct, gives concave shapes, and **produces holes for free** —
   a building the mobs walk around comes out as a hole ring, which the format supports.
3. **Trace contours** (marching squares) → outer ring plus hole rings for each component.
4. **Simplify** each ring — Visvalingam-Whyatt, drop vertices whose triangle with their neighbours
   is under ~4 yalm². `simplifyRing()` in `src/regions.ts` is the reference implementation; a
   60-vertex circle comes out at 36, a raster staircase will thin much harder. Target a few dozen
   vertices per ring. A 200-vertex ring is unreviewable in a diff and painful to edit.
5. **Take each vertex's y from the roam data**, not from a terrain raycast: use the median y of roam
   points within ~6 yalms of that vertex. A mob standing there *is* the floor height, which is
   exactly what the format wants, and it costs nothing.
6. **Assign, and drop `at:`.** Every spawn whose points built a region gets that region. For the
   ~32% with no roam data, assign only if their `at:` falls inside a region built **from the same
   template** — a Wild_Rabbit belongs in a rabbit region, not in whatever polygon happens to cover
   that spot. Anything left over stays unassigned; the human finishes it in the tool, which shows
   exactly those as white dots.

   **A region replaces the fixed spawn point, so an assigned spawn must lose its `at:` line.**
   `patchMobsYaml` does this for you and takes a `positions` map so the reverse works. Read
   positions from the file *before* you patch it — after this runs, those coordinates exist only in
   git history. Note that 120 of west_ronfaure's 602 spawns already have no `at:` at all; don't
   treat that as an error, and don't invent coordinates for them.

### Naming

`<template_lowercased>`, with `_2`, `_3` … appended only when a template has more than one
component. Order components by `(min x, min z)` so names are deterministic across runs. Strip
anything outside `[a-z0-9_]`. These names are YAML keys and are referenced from `mobs.yaml`.

## Output

Write through the visualizer's own patchers rather than emitting YAML yourself:

```js
import { patchZoneYaml, patchMobsYaml, parseMobsYaml } from "xi-visualizer/src/regions.ts";

const mobsIn = readFileSync(mobsPath, "utf8");
const positions = Object.fromEntries(parseMobsYaml(mobsIn).filter(s => s.at).map(s => [s.id, s.at]));

const zoneOut = patchZoneYaml(readFileSync(zonePath, "utf8"), regions);   // adds the `regions:` block
const mobsOut = patchMobsYaml(mobsIn, assign, positions);                 // adds `region:`, removes `at:`
```

They are line-surgical: `mobs.yaml` is 5,000 lines of generated comment header and templates that
must survive untouched, and both are tested against the real files (`node src/regions_files.test.ts`
asserts that stripping the added lines reproduces the originals byte for byte). They also emit the
canonical form — regions sorted, 2 decimals, rings rotated to a stable start vertex — which is what
keeps the first human edit from reformatting the whole file.

**Write the bootstrap in Node so you can import these directly.** A Python re-implementation has to
reproduce the canonical form exactly or every subsequent diff is noise. The existing Python in
`scripts/` is for pathdata processing, not for this.

## Traps

- **Coordinates are raw FFXI**: y grows downward, and the visualizer's scene flips y/z for display
  only. Never flip anything in the data.
- **Regions from different templates will overlap heavily** — rabbits and worms share a field. That
  is fine for the format (membership is authored, not derived) but it makes the editor's "assign
  inside" and click-to-select ambiguous where they overlap; it breaks the tie by smallest area.
  If you can cheaply avoid near-duplicate polygons for templates that share a territory, do.
- **Mobs with 1–2 roam points** carry no useful envelope. Exclude them from region building and let
  the containment pass pick them up.
- **Don't touch `npcs.yaml`**, don't reorder or reformat anything, and don't add a `regions:` block
  to a zone where you produced none.
- **Zones without roam data** (130 of the 161-zone set are covered; the rest are not) get nothing.
  Don't invent regions from spawn points alone — a spawn point tells you nothing about the area.

## Definition of done

For each zone you touch:

1. `node src/regions.test.ts` and `node src/regions_files.test.ts` still pass.
2. Re-parse your own output and assert: every `region:` names a region defined in that zone's
   `regions.yaml`; no ring self-intersects (`selfIntersects()`); every region has at least one spawn;
   report the unassigned count.
3. `git diff` shows **only** `at:` lines replaced by `region:` lines in `mobs.yaml`, one per
   assigned spawn, plus the zone's `regions.yaml`. Any other change is a bug in the
   writer, not a formatting preference.
4. Open the zone in the visualizer's Regions page and look at it. The Review tab lists degenerate
   rings, self-crossings, empty regions, dangling names, and spawns nearer another region's floor.
   It should be quiet. If it is loud, the generator is wrong — do not hand a human a red list.
