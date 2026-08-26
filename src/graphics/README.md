# src/graphics — the rendering layer

Everything that draws a FFXI zone, and nothing about the app around it. Plain TypeScript and
three.js: no SolidJS, no router, no stores. A UI layer hands it a canvas and some parsed data, and
gets back objects to add to a scene and a `dispose()` to call when the view goes away.

It is used by six viewers in `src/components`, and headlessly by `scripts/shot.mjs`.

| file               | what it is                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `viewer.ts`        | the lifecycle: renderer, controls, resize, render loop, teardown. Start here.                    |
| `scene.ts`         | `setupBaseScene()` — the flipped scene, its grid and its light. Read the coordinates section.    |
| `camera.ts`        | the overhead camera, map controls, WASD controls, framing contents into view.                    |
| `ximesh.ts`        | FFXI zone mesh: parsing, colouring, `createZoneMesh`, `prepareMeshData`, `mapIdPerVertex`.       |
| `navmesh.ts`       | Detour navmesh: parsing, surface/edge/off-mesh-link geometry, island colouring, nearest island.  |
| `region_points.ts` | point-cloud materials for roam trails, spawns and vertex handles — custom shaders.               |
| `dynamic_lines.ts` | line geometry that is rewritten every frame without reallocating.                                |
| `selection.ts`     | box selection over a point cloud.                                                                |
| `util.ts`          | `cleanupNode` (recursive geometry/material dispose), raycasting, coordinate parsing.             |

## Coordinates — read this before positioning anything

**Buffers hold raw FFXI zone coordinates. The flip lives on the scene's scale.**

```ts
scene.scale.set(1, -1, -1); // in setupBaseScene()
```

So a vertex, a spawn, a roam point — anything going into a geometry or onto an object that is added
to the scene — goes in exactly as the game file has it. No negation.

**The camera is not in the scene graph.** It does not inherit that scale. Anything handed to the
camera or the controls — a position, a `controls.target`, a `Vector3.project()` for placing an HTML
label — must be flipped by hand:

```ts
camera.position.set(x, -y, -z);
controls.target.set(x, -y, -z);
```

Getting this backwards is the single easiest mistake to make here, and it does not look like an
error: the markers appear mirrored across the middle of the map while the camera still flies to the
right place, so it reads as "the data is wrong" rather than "the sign is wrong". Raycast hits come
back in world space, so they flip the other way on the way out: `{ x: p.x, y: -p.y, z: -p.z }`.

## The lifecycle contract

`createViewer(canvas, options)` owns one WebGL view. One per canvas, disposed exactly once.

```ts
const viewer = createViewer(canvasElement, {
  scene: scene(), // optional; a fresh setupBaseScene() otherwise
  camera: camera(), // optional; createMapCamera() otherwise
  onFrame: dt => {/* animation, per-frame uniforms */},
  onAfterRender: () => {/* HTML labels, which need the updated camera */},
});
// ... later, when the view goes away:
viewer.dispose();
```

What it does each frame, in this order: `controls.update(dt)` → `onFrame(dt)` → resize the drawing
buffer to the canvas → fix the camera aspect → render → `onAfterRender()`. A canvas measuring 0×0
is skipped, since an aspect of `0/0` is `NaN` and poisons the projection matrix from then on.

Other options: `panes` for extra canvases sharing this camera (a side-by-side compare, where a drag
on either moves both), `controlsElement` for when the controls belong on a wrapper rather than the
canvas, `preserveDrawingBuffer` when a screenshot has to read the canvas back, `autoResize: false`
when the canvas is sized by something else.

**`dispose()` must run.** It stops the loop, disposes each renderer, **forces its context loss**,
disposes the controls, and `cleanupNode`s every scene. The forced context loss is the part that is
easy to leave out and expensive to leave out:

> `renderer.dispose()` releases what three.js allocated, but leaves the WebGL context itself alive.
> The canvas goes away, the context does not, and it holds its buffers on the GPU until the browser
> eventually collects it. Browsers cap live contexts at around sixteen and then start force-losing
> the oldest, so swapping zones a dozen times degrades the whole app, and the only thing that fixes
> it is restarting the browser.

That is why the lifecycle is shared: four of the six viewers got this right by hand and two did
not. Nothing outside `viewer.ts` should be calling `new THREE.WebGLRenderer` at all.

## Performance rules

Each of these came out of a real profile of a real zone. They are not style preferences.

**Materials are made once and reused. Never per rebuild, never per frame.**
Materials are decided by a colour and a role, so however many regions a zone has there are only ever
a handful of distinct ones. Building them fresh on each rebuild meant a vertex drag allocated dozens
a frame, and every new `THREE.Material` makes the renderer set up a shader program — which shows up
as a stall in the middle of the drag rather than as a lower frame rate. Custom-shader materials
(`region_points.ts`) are the worst offenders. Make them once, keep them, dispose them at the end.

**No geometry analysis on the render or edit path.**
`selfIntersects` is quadratic in a region's vertices and `containsXZ` walks every point it is given;
Pashhow Marshlands carries 2,268,933 roam points. Dragging a vertex replaces the region set on every
mouse move, so anything reading it at that rate has to be debounced and computed only while somebody
is actually looking at the answer (see the `settled` signal and the coverage effect in
`region_editor.tsx`). Nothing that draws depends on those results — the picture still follows the
mouse exactly.

**Large point clouds are sampled for drawing only, through an index buffer.**
Above `DRAWN_POINT_CAP` (600k, in `region_editor.tsx`) every nth point is drawn, chosen by setting a
`BufferGeometry` index. The position, colour and flag buffers keep their original layout, so
everything that addresses a point by its position in them — colours, floors, hover, the coverage
figure — is untouched and still exact. Do not "optimise" this into a filtered copy of the buffers.
