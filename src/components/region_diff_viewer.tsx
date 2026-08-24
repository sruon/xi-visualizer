import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js";
import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { Line2, LineGeometry, LineMaterial, MapControls } from "three/examples/jsm/Addons.js";
import { addMapControls, adjustCameraAspect, fitCameraToContents } from "../graphics/camera";
import { setupBaseScene } from "../graphics/scene";
import { cleanupNode } from "../graphics/util";
import { ColorKind, createZoneMesh, prepareMeshData } from "../graphics/ximesh";
import type { Region, RegionsDiff, ZoneSide } from "../regions";
import type { ZoneData } from "./zone_model";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export const STATUS_COLOR = {
  added: 0x34d399,
  removed: 0xf87171,
  reshaped: 0xfbbf24,
  unchanged: 0x64748b,
} as const;

export type ChangeStatus = keyof typeof STATUS_COLOR;

interface DiffViewerProps {
  zoneData: ZoneData;
  base: ZoneSide;
  head: ZoneSide;
  diff: RegionsDiff;
  /** Region name to centre on; set it again with a new object to re-trigger. */
  focus?: { name: string; };
}

export default function RegionDiffViewer(props: DiffViewerProps) {
  let canvasElement: HTMLCanvasElement;
  let controls: MapControls | undefined;

  const scene = createMemo(() => setupBaseScene());
  const camera = createMemo(() => {
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 20000);
    cam.position.set(0, 500, 0);
    cam.lookAt(0, 0, 0);
    return cam;
  });

  const statuses = createMemo(() => {
    const map: Record<string, ChangeStatus> = {};
    for (const name of props.diff.added) map[name] = "added";
    for (const name of props.diff.removed) map[name] = "removed";
    for (const change of props.diff.reshaped) map[change.name] = "reshaped";
    for (const name of props.diff.unchanged) map[name] = "unchanged";
    return map;
  });

  const overlay = new THREE.Group();
  const labelRefs = new Map<string, HTMLDivElement>();
  const lineMaterials: LineMaterial[] = [];

  createMemo(() => {
    const prep = prepareMeshData(props.zoneData.mesh);
    const mesh = createZoneMesh(props.zoneData.id, props.zoneData.mesh, prep, ColorKind.None);
    (mesh.geometry.getAttribute("color") as THREE.BufferAttribute).normalized = true;
    (mesh.material as THREE.MeshBasicMaterial).color.setScalar(0.35); // quiet backdrop for the diff
    scene().add(mesh);
    scene().add(overlay);
    onCleanup(() => {
      scene().remove(mesh);
      cleanupNode(mesh);
    });
  });

  const outline = (region: Region, color: number, thick: boolean, opacity: number) => {
    for (const ring of region.rings) {
      if (ring.length < 2) continue;
      if (thick) {
        const points = ring.flat();
        points.push(...ring[0]);
        const geo = new LineGeometry();
        geo.setPositions(points);
        const mat = new LineMaterial({ color, linewidth: 3, depthTest: false, transparent: true, opacity });
        mat.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
        lineMaterials.push(mat);
        const line = new Line2(geo, mat);
        line.renderOrder = 3;
        overlay.add(line);
      } else {
        const geo = new THREE.BufferGeometry().setFromPoints(ring.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
        const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity }));
        line.renderOrder = 2;
        overlay.add(line);
      }
    }
  };

  const fill = (region: Region, color: number, opacity: number) => {
    if ((region.rings[0]?.length ?? 0) < 3) return;
    const flat = [region.rings[0], ...region.rings.slice(1).filter(h => h.length >= 3)];
    const faces = THREE.ShapeUtils.triangulateShape(
      flat[0].map(([x, , z]) => new THREE.Vector2(x, -z)),
      flat.slice(1).map(h => h.map(([x, , z]) => new THREE.Vector2(x, -z))),
    );
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(flat.flat().flat()), 3));
    geo.setIndex(faces.flat());
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthTest: false }));
    mesh.renderOrder = 1;
    overlay.add(mesh);
  };

  createEffect(() => {
    const status = statuses();
    while (overlay.children.length) {
      const child = overlay.children.pop() as THREE.Mesh;
      child.geometry?.dispose();
      (child.material as THREE.Material)?.dispose();
    }
    lineMaterials.length = 0;

    for (const [name, kind] of Object.entries(status)) {
      const color = STATUS_COLOR[kind];
      const before = props.base.regions[name];
      const after = props.head.regions[name];

      // What the old file said, faint underneath, so a reshape reads as a before and an after.
      if (kind === "removed" || kind === "reshaped") {
        if (before) outline(before, color, false, 0.5);
        if (before && kind === "removed") fill(before, color, 0.18);
      }
      if (after) {
        outline(after, color, kind !== "unchanged", kind === "unchanged" ? 0.35 : 1);
        if (kind !== "unchanged") fill(after, color, 0.22);
      }
    }

    // Spawns that changed region, at wherever the new file leaves them standing.
    const moved = props.diff.moved
      .map(m => props.head.spawns.find(s => s.id === m.id))
      .filter((s): s is NonNullable<typeof s> => !!s?.at);
    if (moved.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(moved.flatMap(s => [s.x, s.y, s.z])), 3));
      const points = new THREE.Points(
        geo,
        new THREE.PointsMaterial({ color: STATUS_COLOR.reshaped, size: 7, sizeAttenuation: false, depthTest: false }),
      );
      points.renderOrder = 4;
      overlay.add(points);
    }
  });

  createEffect(() => {
    const name = props.focus?.name;
    if (!name || !controls) return;
    const region = props.head.regions[name] ?? props.base.regions[name];
    if (!region?.rings[0]?.length) return;
    const box = new THREE.Box3();
    for (const [x, y, z] of region.rings[0]) box.expandByPoint(new THREE.Vector3(x, -y, -z)); // scene is flipped
    const center = box.getCenter(new THREE.Vector3());
    const offset = new THREE.Vector3().subVectors(camera().position, controls.target);
    controls.target.copy(center);
    camera().position.copy(center).add(offset);
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
    fitCameraToContents(camera(), controls, fn => overlay.children.forEach(fn));

    const projected = new THREE.Vector3();
    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      controls?.update(clock.getDelta());
      renderer.setSize(canvasElement.clientWidth, canvasElement.clientHeight, false);
      adjustCameraAspect(camera(), canvasElement);
      for (const m of lineMaterials) m.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
      renderer.render(scene(), camera());

      for (const [name, el] of labelRefs) {
        const ring = (props.head.regions[name] ?? props.base.regions[name])?.rings[0];
        if (!ring?.length) {
          el.style.display = "none";
          continue;
        }
        let x = 0, y = 0, z = 0;
        for (const v of ring) (x += v[0], y += v[1], z += v[2]);
        projected.set(x / ring.length, -y / ring.length, -z / ring.length).project(camera());
        el.style.display = projected.z < 1 ? "block" : "none";
        el.style.transform = `translate(-50%, -50%) translate(${(projected.x * 0.5 + 0.5) * canvasElement.clientWidth}px, ${
          (-projected.y * 0.5 + 0.5) * canvasElement.clientHeight
        }px)`;
      }
    });

    onCleanup(() => {
      window.removeEventListener("resize", resizeCanvas);
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

  // Only changed regions get a label; naming the unchanged ones would bury the ones that matter.
  const labelled = createMemo(() => Object.entries(statuses()).filter(([, kind]) => kind !== "unchanged"));

  return (
    <div class="relative h-full">
      <canvas class="block w-full h-full outline-none" ref={canvasElement!} />
      <div class="absolute inset-0 overflow-hidden pointer-events-none">
        <For each={labelled()}>
          {([name, kind]) => {
            onCleanup(() => labelRefs.delete(name));
            return (
              <div
                ref={el => labelRefs.set(name, el)}
                class="absolute top-0 left-0 hidden whitespace-nowrap text-xs font-bold px-1.5 py-0.5 rounded bg-slate-900/80"
                style={{ color: `#${STATUS_COLOR[kind].toString(16)}` }}
              >
                {name}
              </div>
            );
          }}
        </For>
      </div>
      <div class="absolute top-2 left-2 flex gap-3 text-xs bg-slate-900/75 rounded px-2 py-1 pointer-events-none">
        <For each={Object.entries(STATUS_COLOR)}>
          {([kind, color]) => (
            <span style={{ color: `#${color.toString(16)}` }}>
              {kind}
              <Show when={kind === "removed" || kind === "reshaped"}>
                <span class="text-slate-500">(thin = before)</span>
              </Show>
            </span>
          )}
        </For>
      </div>
    </div>
  );
}
