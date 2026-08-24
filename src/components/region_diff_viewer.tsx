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
  /** What to go and look at: a region by name, or one spawn by id. Set it again with a new object
   * to re-trigger, since asking for the same thing twice is a thing people do. */
  focus?: { name?: string; spawn?: string; };
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

  /**
   * `thick` draws the version that is there now; anything else is a before.
   *
   * A before used to be the same colour, thinner. When a reshape is a simplification the outline
   * follows nearly the same path, so the thin line sat underneath the thick one and there was
   * nothing to see -- the change looked like no change. Dashes read through an overlap.
   */
  const outline = (region: Region, color: number, thick: boolean, opacity: number, dashed = false) => {
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
        const points = ring.map(([x, y, z]) => new THREE.Vector3(x, y, z));
        const geo = new THREE.BufferGeometry().setFromPoints([...points, points[0].clone()]);
        const line = new THREE.Line(
          geo,
          dashed
            ? new THREE.LineDashedMaterial({ color, depthTest: false, transparent: true, opacity, dashSize: 4, gapSize: 3 })
            : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity }),
        );
        if (dashed) line.computeLineDistances();
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
        // Dashed, and brighter than it was: a before nobody can pick out is not worth drawing.
        if (before) outline(before, color, false, 0.9, true);
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

  /**
   * A move in progress: a dot walking from where the mob was to where it is now, on a loop.
   *
   * Two pins and a line say a move happened but leave which end is which to be worked out. A dot
   * that sets off from one and arrives at the other says it without a legend, and the region it
   * left is held bright while it goes and fades once it has gone.
   */
  let walking: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    dot: THREE.Object3D;
    leaving: THREE.Material[];
    elapsed: number;
  } | null = null;

  // Whatever is being looked at, drawn on top of everything so it is findable among the rest.
  const marker = new THREE.Group();
  marker.renderOrder = 6;
  createEffect(() => scene().add(marker));
  onCleanup(() => cleanupNode(marker));

  /** Where a spawn actually stands on one side: its own point, or the middle of the region placing it. */
  const standsAt = (side: ZoneSide, id: string, regionName?: string | null) => {
    const spawn = side.spawns.find(sp => sp.id === id);
    if (spawn?.at) return new THREE.Vector3(spawn.x, -spawn.y, -spawn.z);
    const ring = regionName ? side.regions[regionName]?.rings[0] : undefined;
    if (!ring?.length) return null;
    const middle = ring.reduce((sum, [x, y, z]) => sum.add(new THREE.Vector3(x, -y, -z)), new THREE.Vector3());
    return middle.divideScalar(ring.length);
  };

  const ringLine = (ring: readonly (readonly number[])[], colour: number) => {
    const points = ring.map(([x, y, z]) => new THREE.Vector3(x, -y, -z));
    points.push(points[0].clone());
    return new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: colour, depthTest: false }),
    );
  };

  const pin = (at: THREE.Vector3, colour: number) => {
    const group = new THREE.Group();
    const stalk = new THREE.BufferGeometry().setFromPoints([at, at.clone().setY(at.y + 30)]);
    group.add(new THREE.Line(stalk, new THREE.LineBasicMaterial({ color: colour, depthTest: false })));
    const dot = new THREE.BufferGeometry().setFromPoints([at]);
    group.add(new THREE.Points(dot, new THREE.PointsMaterial({ color: colour, size: 12, sizeAttenuation: false, depthTest: false })));
    return group;
  };

  createEffect(() => {
    const want = props.focus;
    walking = null;
    while (marker.children.length) cleanupNode(marker.children.pop()!);
    if (!want || !controls) return;

    // Scene coordinates are flipped on the scale, so points go in negated on y and z.
    const box = new THREE.Box3();

    if (want.spawn) {
      // A move has two ends and showing one of them explains nothing. A spawn placed by a region
      // has no point of its own -- the region replaced it -- so "where it is" means that region.
      const move = props.diff.moved.find(m => m.id === want.spawn);
      const from = standsAt(props.base, want.spawn, move?.from);
      const to = standsAt(props.head, want.spawn, move?.to);
      if (!from && !to) return;

      const fromRing = move?.from ? props.base.regions[move.from]?.rings[0] : undefined;
      const toRing = move?.to ? props.head.regions[move.to]?.rings[0] : undefined;
      const leaving: THREE.Material[] = [];
      if (fromRing?.length) {
        const line = ringLine(fromRing, STATUS_COLOR.removed);
        (line.material as THREE.Material).transparent = true;
        leaving.push(line.material as THREE.Material);
        marker.add(line);
      }
      if (toRing?.length) marker.add(ringLine(toRing, STATUS_COLOR.added));
      if (from) (marker.add(pin(from, STATUS_COLOR.removed)), box.expandByPoint(from));
      if (to) (marker.add(pin(to, STATUS_COLOR.added)), box.expandByPoint(to));

      if (from && to) {
        // The path it took, faint, so the route is there even between passes of the dot.
        marker.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([from.clone().setY(from.y + 20), to.clone().setY(to.y + 20)]),
          new THREE.LineBasicMaterial({ color: 0xfff066, depthTest: false, transparent: true, opacity: 0.35 }),
        ));
        const dot = new THREE.Points(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]),
          new THREE.PointsMaterial({ color: 0xfff066, size: 16, sizeAttenuation: false, depthTest: false }),
        );
        marker.add(dot);
        walking = { from: from.clone().setY(from.y + 20), to: to.clone().setY(to.y + 20), dot, leaving, elapsed: 0 };
      }
    } else if (want.name) {
      const region = props.head.regions[want.name] ?? props.base.regions[want.name];
      if (!region?.rings[0]?.length) return;
      for (const ring of region.rings) {
        if (ring.length < 2) continue;
        marker.add(ringLine(ring, 0xfff066));
        for (const [x, y, z] of ring) box.expandByPoint(new THREE.Vector3(x, -y, -z));
      }
    } else {
      return;
    }

    // Close enough that it fills the view rather than merely being in it, keeping whatever angle
    // the camera was already at. Both ends of a move have to fit, however far apart they are.
    const centre = box.getCenter(new THREE.Vector3());
    // Neighbouring regions can be a few yalms apart, and framing exactly that puts the camera on
    // top of one spot with no ground around it to say where it is. A move needs its surroundings
    // more than it needs to fill the frame.
    const floor = want.spawn ? 70 : 12;
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, floor);
    const distance = (radius * 2.2) / Math.tan((camera().fov * Math.PI) / 360);
    const direction = new THREE.Vector3().subVectors(camera().position, controls.target).normalize();
    if (!direction.lengthSq()) direction.set(0, 1, 0);
    controls.target.copy(centre);
    camera().position.copy(centre).addScaledVector(direction, distance);
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
      const dt = clock.getDelta();
      controls?.update(dt);
      if (walking) {
        const TRAVEL = 1.6, PAUSE = 0.7;
        walking.elapsed = (walking.elapsed + dt) % (TRAVEL + PAUSE);
        const t = Math.min(walking.elapsed / TRAVEL, 1);
        // Eased, because something that sets off and arrives reads as going somewhere, where
        // something at constant speed reads as a moving decoration.
        const eased = t * t * (3 - 2 * t);
        walking.dot.position.lerpVectors(walking.from, walking.to, eased);
        // The region it left stays bright until it is most of the way there, then gives way.
        for (const m of walking.leaving) (m as THREE.Material & { opacity: number; }).opacity = 1 - eased * 0.8;
      }
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
                <span class="text-slate-500">(dashed = before)</span>
              </Show>
            </span>
          )}
        </For>
      </div>
    </div>
  );
}
