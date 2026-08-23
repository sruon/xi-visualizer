# Spawn regions

As merged in LSB. Geometry lives in `data/zones/<zone>/regions.yaml`, membership in the same zone's
`mobs.yaml`. The visualizer's Regions page reads and writes both in place, and creates regions.yaml
for the zones that have none yet.

Authoritative schemas: `data/schemas/regions.schema.json` and `data/schemas/mobs.schema.json`.
Loaders: `src/map/data/datasets/zones/regions/` and `.../zones/mobs/`.

```yaml
# regions.yaml
# yaml-language-server: $schema=../../schemas/regions.schema.json

regions:

  rabbit_field:
    poly:
      - [-317.41, -52.49, 308.69]   # x, y, z, y being the ground under that corner
      - [-290.11, -52.31, 283.01]
      - [-285.31, -51.88, 279.85]
    holes:
      -   - [-300.00, -52.20, 290.00]
          - [-295.00, -52.14, 292.00]
          - [-297.00, -52.10, 294.00]
```

Every ring needs at least 3 corners and exactly 3 numbers per corner; the loader rejects anything else.

```yaml
# mobs.yaml
spawns:
  17186822:
    template: Wild_Rabbit
    region:   rabbit_field   # takes the line at: had, and places this spawn
    level:    [1, 1]
  17186823:
    template: Tunnel_Worm
    at:       [-274.086, -50.896, 300.383, 108]   # optional 4th value is a facing, 0-255
    level:    [1, 1]
```

A spawn that patrols a fixed route carries the legs inline, under one of two keys:

```yaml
  17186830:
    template: Orcish_Fodder
    circuit:                 # closed: the last waypoint leads back to the first
      - [-317.406, -52.494, 308.691]
      - [-290.112, -52.310, 283.010]
      - [-285.310, -51.880, 279.846]
    level:    [9, 9]
  17186831:
    template: Orcish_Fodder
    path:                    # out and back: the same legs retraced, then looped
      - [-317.406, -52.494, 308.691]
      - [-290.112, -52.310, 283.010]
    level:    [9, 9]
```

`path:` is expanded at load into the circuit with the return trip spelled out, so the two differ
only in what you have to write.

**A spawn is placed by exactly one of `at:`, `region:`, `path:` and `circuit:`** — the loader throws
on more than one. The mob spawns on the first leg, so a route replaces the fixed point the same way
a region does.

That makes assignment destructive in one direction: once a zone is saved, an assigned spawn's
original coordinates exist only in git history. The visualizer keeps them for the session so
unassign works, and its review tab counts spawns left with neither.

## Why it looks like this

- **Rings of `[x, y, z]`, outline first, then holes** — earcut's own input shape, and its `dim: 3`
  triangulates on x/z while carrying y through untouched. `earcut(poly, holes, 3)` needs no massaging.
- **No vertical bounds.** The polygon *is* the floor: y comes from the ground under each corner.
  Containment is the horizontal test; when regions overlap in x/z, the one whose floor is nearest
  the entity's y wins. FFXI floors are 10-20 yalms apart and mobs sit within ~3 of theirs, so that
  is unambiguous without a tolerance to tune.
- **Implicit closure, no winding requirement.** earcut accepts either winding and the point-in-polygon
  test does too, so neither is a rule that could be violated.
- **World coordinates, not navmesh polygon refs.** Refs change on every mesh rebuild; coordinates don't.
- **Membership on the spawn, not a list under the region.** YAML key uniqueness then makes "one spawn
  belongs to one region" impossible to violate, and the diff lands next to the mob it describes.

## Canonical form

LSB's CI runs `python tools/yaml/format.py --check` over every changed YAML file, so a writer that
gets this wrong turns every PR red. What the visualizer emits, and what any other writer should:

- regions sorted by name, one blank line between them;
- coordinates at exactly 2 decimals in regions.yaml (`-317.41`, not `-317.4` or `-317.406`),
  3 in `at:`, `path:` and `circuit:`;
- each ring rotated to start at its lexicographically smallest `(x, z)` vertex;
- one vertex per line, so nudging a corner is a one-line diff;
- `poly` before `holes`; `holes` omitted entirely when there are none;
- nested hole rings indented ruamel's way (`sequence=4, offset=2`), which is the `-   - [` /
  `          - [` shape above;
- inside a spawn, each run of `key: value` lines padded to the run's widest key. Adding `region:`
  to an entry can change that width, so the whole entry is re-padded, not just the new line.

Simplify generated rings before writing (Visvalingam or Douglas-Peucker). A 200-vertex hull is not
reviewable in a diff and is painful to edit, and whatever gets written is the shape that zone keeps.

The cross-file reference (a `region:` naming something regions.yaml doesn't define) is not
expressible in JSON Schema; the visualizer's review tab flags it.
