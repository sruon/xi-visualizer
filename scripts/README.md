# scripts

## shot.mjs — headless rendering

One entry point over the viewers in [`src/graphics`](../src/graphics/README.md). It drives the app
in a real browser (puppeteer over Edge or Chrome) and writes PNGs, so a change to the rendering
layer can be looked at rather than argued about.

```
node scripts/shot.mjs <command> [args]
```

| command                                | writes                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `zone <out.png> <file.nav> [tilt]`     | one navmesh from above, `tilt` to drag the camera off straight-down first. Echoes the stats panel.                          |
| `offmesh <out.png> <file.nav> [x,y,z]` | the same, islands coloured apart and zoomed in. With a coordinate, jumps there first.                                       |
| `diff <out.png> <a.nav> <b.nav>`       | two navmeshes compared in one image. Echoes the diff panel.                                                                |
| `batch <baseDir> <mineDir> <outDir>`   | `diff` for every zone present in both folders: `<zone>.png` each, plus `manifest.json` of the per-zone counts.              |
| `gallery <diffsDir>`                   | `index.html` contact sheet over what `batch` wrote, biggest diffs first. No browser involved.                               |
| `points <points.json> <outDir> [scale]` | a top-down map per group with the given positions marked in red. Input is `[{ zone, group, kind?, x, y, z }]`, raw game coordinates. |
| `check`                                | nothing — prints whether the diff page comes up. Run this first when a shot comes out empty.                                |

Common bits, the same for every command:

- **The browser** is the first of `$BROWSER`, Edge, or Chrome that exists. Rendering is
  swiftshader, so it does not need a GPU.
- **The app** is `$URL` when something is already serving it; otherwise a vite dev server is
  started on port 5189 and killed on the way out. Meshes come out of `public/`, so a dev server is
  enough — no build needed.
- **Coordinates** in any input are raw FFXI zone coordinates. The scene carries the y/z flip
  itself, so nothing here converts anything. See the coordinate section of the graphics README
  before adding a command that positions something.

`points` drives the zone page through the `window.__zoneView` handle that `zone_model.tsx` publishes
on mount and deletes on teardown. If it hangs waiting for that handle, check the zone page still sets
it: nothing else in the app reads it, so it is easy to drop by accident.

## ctx_probe.mjs

`node scripts/ctx_probe.mjs` swaps zones and counts WebGL contexts created against contexts
released. It exits non-zero if more than one is left live, so it catches a viewer that disposes
without handing its GL context back. Run it after touching viewer teardown.

## Measuring, and the instruments that lie

Most of the wrong answers this repo has produced came from a bad measurement rather than a bad
theory. In rough order of how much time each one cost:

- **A real DevTools trace from the affected machine beats any local probe.** Ask for
  `Performance -> record -> Save profile`. Parse it by walking `traceEvents` for `cpuProfile`
  nodes and samples, accumulating self time. Some traces have `timeDeltas` summing to zero, in
  which case count samples instead.
- **Headless Chrome here runs software GL at about 4fps** and pegs the main thread whatever the
  page does, so `(program)` dominates every profile. Fine for correctness, useless for speed.
- **Assert the probe sees what it claims to measure.** `ctx_probe.mjs` fails loudly when no
  context appears, because a page that never drew reports a clean zero that reads as a pass.
  A wrong route did exactly that here: `/zone/:id` takes a numeric zone id, not a folder name.
- **Do not compare screenshots by a prefix of their base64.** The first bytes are the top
  scanlines, so anything moving mid-canvas compares equal. Hash the whole image.
- **`gl.readPixels()` after the frame is presented returns nothing** without
  `preserveDrawingBuffer`. Screenshot the canvas element instead.
- **One `window.gc()` does not settle the heap.** Call it more than once, and use the same
  procedure on both sides of a comparison, or you measure your own method.
- **Confirm which bundle is being served** before trusting any of this. A stale preview server
  on a held port served an old build through a whole round of testing; the app puts its commit
  in the nav bar so this is checkable.

## The rest

- `smoke.mjs` — drives the regions editor in a real browser and asserts what would otherwise only
  break in front of someone. Part of the gate: `pnpm build && pnpm smoke`.
- `relay-dev.mjs`, `relay-secrets.mjs` — the GitHub relay worker, nothing to do with rendering.
- `*.py` — one-off data conversions for the roam path data.
