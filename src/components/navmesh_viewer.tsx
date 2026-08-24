import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { MapControls } from "three/examples/jsm/Addons.js";
import { addMapControls, adjustCameraAspect } from "../graphics/camera";
import { buildNavMeshGroup, nearestIsland, parseNavMesh } from "../graphics/navmesh";
import { setupBaseScene } from "../graphics/scene";
import { cleanupNode } from "../graphics/util";
import { ColorKind, createZoneMesh, prepareMeshData } from "../graphics/ximesh";
import { decompress } from "../util";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

interface NavMeshViewerProps {
  navData: ArrayBuffer;
  fileName: string;
}

export default function NavMeshViewer(props: NavMeshViewerProps) {
  let canvasElement: HTMLCanvasElement;
  let controls: MapControls | undefined;
  let marker: THREE.Object3D | undefined;

  const [showSurface, setShowSurface] = createSignal(true);
  const [showEdges, setShowEdges] = createSignal(true);
  const [colorByTile, setColorByTile] = createSignal(false);
  const [colorByComponent, setColorByComponent] = createSignal(true);
  const [showOffMesh, setShowOffMesh] = createSignal(true);
  const [opacity, setOpacity] = createSignal(0.85);
  const [hoverPos, setHoverPos] = createSignal<{ x: number; y: number; z: number; } | null>(null);
  const [coordText, setCoordText] = createSignal("");
  const [snapInfo, setSnapInfo] = createSignal("");

  const [showXimesh, setShowXimesh] = createSignal(false);
  const [ximeshStatus, setXimeshStatus] = createSignal("");

  const scene = createMemo(() => setupBaseScene());
  const camera = createMemo(() => {
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 5000);
    cam.position.set(0, 500, 0);
    cam.lookAt(0, 0, 0);
    return cam;
  });

  // Parse once per uploaded file.
  const parsed = createMemo(() => parseNavMesh(props.navData));

  // (Re)build the navmesh group whenever the file or a display toggle changes.
  createEffect(() => {
    const group = buildNavMeshGroup(parsed(), {
      showSurface: showSurface(),
      showEdges: showEdges(),
      colorByTile: colorByTile(),
      colorByComponent: colorByComponent(),
      showOffMesh: showOffMesh(),
      opacity: opacity(),
    });
    scene().add(group);
    onCleanup(() => {
      scene().remove(group);
      cleanupNode(group);
    });
  });

  // Zone collision overlay: derive the matching ".ximesh" from the uploaded
  // filename (they share the zone-name convention) and lazy-load on first enable.
  const [everShowXimesh, setEverShowXimesh] = createSignal(false);
  createEffect(() => {
    if (showXimesh()) setEverShowXimesh(true);
  });

  const [ximesh] = createResource(
    () => (everShowXimesh() ? props.fileName : undefined),
    async fileName => {
      const base = fileName.replace(/\.nav$/i, "");
      const url = `${import.meta.env.BASE_URL}/ximeshes/${encodeURIComponent(base)}.ximesh`;

      setXimeshStatus("Loading ximesh…");
      try {
        const res = await fetch(url);
        if (!res.ok) {
          setXimeshStatus(`No ximesh for ${base}`);
          return undefined;
        }

        const bytes = await decompress(await res.arrayBuffer());
        const prep = prepareMeshData(bytes);
        const mesh = createZoneMesh(0, bytes, prep, ColorKind.Materials);
        mesh.name = "ximesh-overlay";
        setXimeshStatus("");
        return mesh;
      } catch (e) {
        setXimeshStatus(`ximesh error: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    },
  );

  // Add the overlay to the scene once loaded; visibility follows the toggle.
  createEffect(() => {
    const mesh = ximesh();
    if (!mesh) return;

    scene().add(mesh);
    onCleanup(() => {
      scene().remove(mesh);
      cleanupNode(mesh);
    });
  });

  createEffect(() => {
    const mesh = ximesh();
    if (mesh) mesh.visible = showXimesh();
  });

  const fitToView = () => {
    if (!controls) return;

    const box = new THREE.Box3();
    scene().traverse(obj => {
      // Only the navmesh itself, not the 2000-unit background GridHelper.
      if (obj.name === "navmesh-surface" || obj.name === "navmesh-edges") {
        box.expandByObject(obj);
      }
    });
    if (box.isEmpty()) return;

    // The scene is scaled (1, -1, -1), so undo that when framing.
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    center.y = -center.y;
    center.z = -center.z;

    const cam = camera();
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = (maxDim / 2 / Math.tan((cam.fov * Math.PI) / 360)) * 1.2;

    const dir = new THREE.Vector3().subVectors(cam.position, controls.target).normalize();
    if (dir.lengthSq() === 0) dir.set(0, 1, 0.0001).normalize();
    cam.position.copy(center).addScaledVector(dir, dist);
    controls.target.copy(center);
    cam.lookAt(center);
    controls.update();
  };

  // A bright pin (sphere + tall vertical needle) marking a snapped coordinate.
  // Lives as a child of the scaled scene, so its local FFXI (x, y, z) co-locates
  // with the navmesh geometry (also stored in FFXI coords).
  const makeMarker = (): THREE.Object3D => {
    const g = new THREE.Group();
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(2, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff2d55, depthTest: false }),
    );
    const needle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.35, 80, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2d55, depthTest: false, transparent: true, opacity: 0.7 }),
    );
    needle.position.y = 40;
    ball.renderOrder = 999;
    needle.renderOrder = 999;
    g.add(ball);
    g.add(needle);
    g.name = "coord-marker";
    return g;
  };

  // Snap the camera to an FFXI coordinate, drop a marker, and report which
  // walkable island that point sits on.
  const goToCoord = () => {
    const nums = coordText().trim().split(/[\s,]+/).map(Number).filter(n => !Number.isNaN(n));
    if (nums.length < 3) {
      setSnapInfo("enter: x y z");
      return;
    }

    const [x, y, z] = nums;

    if (!marker) {
      marker = makeMarker();
      scene().add(marker);
    }

    marker.position.set(x, y, z);
    marker.visible = true;

    const hit = nearestIsland(parsed(), x, y, z);
    setSnapInfo(
      hit
        ? `island #${hit.island} · ${hit.size.toLocaleString()} polys · ${hit.dist.toFixed(1)}u to mesh`
        : "no navmesh nearby",
    );

    if (controls) {
      const cam = camera();
      const center = new THREE.Vector3(x, y, z);
      const dir = new THREE.Vector3().subVectors(cam.position, controls.target).normalize();
      if (dir.lengthSq() === 0) dir.set(0, 1, 0.0001).normalize();
      cam.position.copy(center).addScaledVector(dir, 80);
      controls.target.copy(center);
      cam.lookAt(center);
      controls.update();
    }
  };

  // Frame the mesh once after the first build.
  createEffect(() => {
    parsed();
    queueMicrotask(fitToView);
  });

  onMount(() => {
    const resizeCanvas = () => {
      const rect = canvasElement.parentElement!.getBoundingClientRect();
      canvasElement.width = rect.width;
      canvasElement.height = rect.height;
    };

    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();

    controls = addMapControls(camera(), canvasElement);
    const renderer = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: true, alpha: true });

    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true;
    const mouse = new THREE.Vector2();

    const onMouseMove = (event: MouseEvent) => {
      const surface = scene().getObjectByName("navmesh-surface") as THREE.Mesh | undefined;
      if (!surface) {
        setHoverPos(null);
        return;
      }

      const rect = canvasElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera());
      const hits = raycaster.intersectObject(surface, false);
      if (hits.length > 0) {
        const p = hits[0].point;
        // Undo the scene flip to report true FFXI coordinates.
        setHoverPos({ x: p.x, y: -p.y, z: -p.z });
      } else {
        setHoverPos(null);
      }
    };

    canvasElement.addEventListener("mousemove", onMouseMove);

    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      controls?.update(clock.getDelta());
      renderer.setSize(canvasElement.clientWidth, canvasElement.clientHeight, false);
      adjustCameraAspect(camera(), canvasElement);
      renderer.render(scene(), camera());
    });

    // The build effect already added the group; frame it now that controls exist.
    fitToView();

    onCleanup(() => {
      window.removeEventListener("resize", resizeCanvas);
      canvasElement.removeEventListener("mousemove", onMouseMove);
      renderer.setAnimationLoop(null);
      renderer.dispose();
      // dispose() releases what three.js allocated, but leaves the WebGL context itself alive: the
      // canvas goes away, the context does not, and it holds its buffers on the GPU until the
      // browser eventually collects it. Swapping zones a dozen times reaches the limit a browser
      // keeps contexts for, and the only thing that frees them is restarting the browser.
      renderer.forceContextLoss();
      controls?.dispose();
      cleanupNode(scene());
    });
  });

  return (
    <div class="flex gap-4" style={{ height: "70vh" }}>
      <div class="flex-1 relative">
        <canvas class="block w-full h-full outline-none" ref={canvasElement!} />
        <Show when={hoverPos()}>
          <div class="absolute bottom-2 left-2 bg-slate-900/80 text-white px-2 py-1 rounded text-xs font-mono pointer-events-none">
            {hoverPos()!.x.toFixed(2)}, {hoverPos()!.y.toFixed(2)}, {hoverPos()!.z.toFixed(2)}
          </div>
        </Show>
      </div>
      <div class="w-56 flex flex-col bg-slate-800 rounded-lg p-3 gap-2 text-sm">
        <div class="font-bold truncate" title={props.fileName}>{props.fileName}</div>
        <div class="text-xs text-slate-400 leading-relaxed">
          tiles: <span class="text-slate-200">{parsed().stats.numTiles.toLocaleString()}</span>
          <br />
          polys: <span class="text-slate-200">{parsed().stats.totalPolys.toLocaleString()}</span>
          <br />
          verts: <span class="text-slate-200">{parsed().stats.totalVerts.toLocaleString()}</span>
          <br />
          islands: <span class="text-slate-200">{parsed().components.islands.toLocaleString()}</span>{" "}
          <span class="text-slate-500">(largest {parsed().components.largestPct.toFixed(1)}%)</span>
          <br />
          off-mesh links: <span class="text-slate-200">{parsed().stats.offMeshLinks.toLocaleString()}</span>
        </div>

        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={showSurface()} onChange={e => setShowSurface(e.currentTarget.checked)} />
          Filled surface
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={showEdges()} onChange={e => setShowEdges(e.currentTarget.checked)} />
          Poly edges
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={colorByTile()}
            onChange={e => {
              setColorByTile(e.currentTarget.checked);
              if (e.currentTarget.checked) setColorByComponent(false);
            }}
          />
          Color by tile
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={colorByComponent()}
            onChange={e => {
              setColorByComponent(e.currentTarget.checked);
              if (e.currentTarget.checked) setColorByTile(false);
            }}
          />
          Color by island
        </label>
        <Show when={colorByComponent()}>
          <div class="text-xs text-slate-400 -mt-1">
            Each color = one connected walkable region Detour can path within. Grey = specks (&lt;3 polys). Many colors = fragmented mesh.
          </div>
        </Show>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={showOffMesh()} onChange={e => setShowOffMesh(e.currentTarget.checked)} />
          Off-mesh links <span class="text-rose-400">●</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={showXimesh()} onChange={e => setShowXimesh(e.currentTarget.checked)} />
          Zone collision (ximesh)
        </label>
        <Show when={ximesh.loading || ximeshStatus()}>
          <div class="text-xs text-slate-400 -mt-1">{ximesh.loading ? "Loading ximesh…" : ximeshStatus()}</div>
        </Show>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-slate-400">Surface opacity</span>
          <input
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            value={opacity()}
            onInput={e => setOpacity(parseFloat(e.currentTarget.value))}
          />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-slate-400">Go to coord (x y z)</span>
          <div class="flex gap-1">
            <input
              type="text"
              placeholder="-20 14 -9"
              value={coordText()}
              onInput={e => setCoordText(e.currentTarget.value)}
              onKeyDown={e => {
                if (e.key === "Enter") goToCoord();
              }}
              class="flex-1 min-w-0 px-2 py-1 bg-slate-900 rounded font-mono text-xs"
            />
            <button class="px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded" onClick={goToCoord}>
              Go
            </button>
          </div>
        </label>
        <Show when={snapInfo()}>
          <div class="text-xs text-rose-300 -mt-1 font-mono">{snapInfo()}</div>
        </Show>

        <button
          class="mt-1 px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded"
          onClick={fitToView}
        >
          Fit to view
        </button>
        <div class="text-xs text-slate-500 mt-auto">Hover the surface to read coordinates.</div>
      </div>
    </div>
  );
}
