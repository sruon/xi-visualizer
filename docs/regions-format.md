# Spawn regions

Geometry lives in `data/zones/<zone>/zone.yaml`, membership in the same zone's `mobs.yaml`.
The visualizer's Regions page reads and writes both in place.

```yaml
# zone.yaml
regions:

  rabbit_field:
    poly:
      - [-317.41, -52.49, 308.69]   # x, y, z — y is the ground under that corner
      - [-290.11, -52.31, 283.01]
      - [-285.31, -51.88, 279.85]
    holes:
      - - [-300.00, -52.20, 290.00]
        - [-295.00, -52.14, 292.00]
```

```yaml
# mobs.yaml
spawns:
  17186822:
    template: Wild_Rabbit
    level:    [1, 1]
    region:   rabbit_field   # replaces at: — the region places this spawn
  17186823:
    template: Tunnel_Worm
    at:       [-274.086, -50.896, 300.383, 108]
    level:    [1, 1]
```

**`region:` and `at:` are mutually exclusive.** A region places the spawn, so assigning one removes
the fixed point and unassigning restores it. That makes assignment destructive in one direction:
once a zone is saved, an assigned spawn's original coordinates exist only in git history. The
visualizer keeps them for the session so unassign works, and its review tab counts spawns left with
neither.

## Why it looks like this

- **Rings of `[x, y, z]`, outline first, then holes** — earcut's own input shape, and its `dim: 3`
  triangulates on x/z while carrying y through untouched. `earcut(poly, holes, 3)` needs no massaging.
- **No vertical bounds.** The polygon *is* the floor: y comes from the ground under each corner.
  Containment is the horizontal test; when regions overlap in x/z, the one whose floor is nearest
  the entity's y wins. FFXI floors are 10–20 yalms apart and mobs sit within ~3 of theirs, so that
  is unambiguous without a tolerance to tune.
- **Implicit closure, no winding requirement.** earcut accepts either winding and the point-in-polygon
  test does too, so neither is a rule that could be violated.
- **World coordinates, not navmesh polygon refs.** Refs change on every mesh rebuild; coordinates don't.
- **Membership on the spawn, not a list under the region.** YAML key uniqueness then makes "one spawn
  belongs to one region" impossible to violate, and the diff lands next to the mob it describes.

## Canonical form

Any writer — the bootstrap script included — should emit this, so re-saving a file it did not
write produces an empty diff instead of whole-file churn:

- regions sorted by name;
- coordinates at exactly 2 decimals (`-317.41`, not `-317.4` or `-317.406`);
- each ring rotated to start at its lexicographically smallest `(x, z)` vertex;
- one vertex per line, so nudging a corner is a one-line diff;
- `poly` before `holes`; `holes` omitted entirely when there are none.

Simplify generated rings before writing (Visvalingam or Douglas–Peucker). A 200-vertex hull is not
reviewable in a diff and is painful to edit, and whatever the bootstrap emits is the shape that
zone keeps.

## Schema fragments

For `zone.schema.json`:

```json
"regions": {
  "type": "object",
  "description": "Named areas in this zone, keyed by name",
  "additionalProperties": {
    "type": "object",
    "required": ["poly"],
    "additionalProperties": false,
    "properties": {
      "poly": { "$ref": "#/$defs/ring", "description": "Outline, counted as closed" },
      "holes": { "type": "array", "items": { "$ref": "#/$defs/ring" }, "description": "Areas cut out of the outline" }
    }
  }
}
```

```json
"$defs": {
  "ring": {
    "type": "array",
    "minItems": 3,
    "items": { "type": "array", "minItems": 3, "maxItems": 3, "items": { "type": "number" } },
    "description": "Vertices as x, y, z; y is the floor height at that corner"
  }
}
```

For `mobs.schema.json`, on a spawn entry:

```json
"region": { "type": "string", "description": "Name of a region defined in this zone's zone.yaml" }
```

The cross-file reference (a `region:` naming something zone.yaml doesn't define) is not expressible
in JSON Schema; the visualizer's review tab flags it, and the loader should too.
