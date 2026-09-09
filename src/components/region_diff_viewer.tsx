import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { Line2, LineGeometry, LineMaterial, MapControls } from "three/examples/jsm/Addons.js";
import { createMapCamera, fitCameraToContents } from "../graphics/camera";
import { setupBaseScene } from "../graphics/scene";
import { cleanupNode } from "../graphics/util";
import { createViewer } from "../graphics/viewer";
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
  /** Recorded roam points, xyz flat, of whatever is in focus. */
  trail?: Float32Array;
  /** Clicking a label on the map is the same act as clicking its row in the list. */
  onPick?: (name: string) => void;
}

export default function RegionDiffViewer(props: DiffViewerProps) {
  let canvasElement: HTMLCanvasElement;
  let controls: MapControls | undefined;

  const scene = createMemo(() => setupBaseScene());
  const camera = createMemo(() => createMapCamera(20000));

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

  let zoneMesh: THREE.Mesh | undefined;
  // Zone coordinates under the cursor, for reading a spot off the map and copying it.
  const [cursor, setCursor] = createSignal<THREE.Vector3 | undefined>();
  const [toast, setToast] = createSignal<string | undefined>();
  const xyz = (p: THREE.Vector3) => [p.x, p.y, p.z].map(n => n.toFixed(3)).join(" ");
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setToast(`copied ${text}`);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(undefined), 2400);
  };
  onCleanup(() => clearTimeout(toastTimer));

  createMemo(() => {
    const prep = prepareMeshData(props.zoneData.mesh);
    // Coloured by material as the editor does: the mesh is unlit, so one flat grey has no walls,
    // no water and no floor in it, and a region on the map might as well be on a blank page.
    const mesh = createZoneMesh(props.zoneData.id, props.zoneData.mesh, prep, ColorKind.Materials);
    (mesh.geometry.getAttribute("color") as THREE.BufferAttribute).normalized = true;
    (mesh.material as THREE.MeshBasicMaterial).color.setScalar(0.5); // quiet backdrop for the diff
    zoneMesh = mesh;
    scene().add(mesh);
    scene().add(overlay);
    onCleanup(() => {
      scene().remove(mesh);
      cleanupNode(mesh);
      if (zoneMesh === mesh) zoneMesh = undefined;
    });
  });

  /**
   * `thick` draws the version that is there now; anything else is a before.
   *
   * A before used to be the same colour, thinner. When a reshape is a simplification the outline
   * follows nearly the same path, so the thin line sat underneath the thick one and there was
   * nothing to see -- the change looked like no change. Dashes read through an overlap.
   */
  /** A ring's identity, independent of where it was written to start. */
  const ringKey = (ring: readonly (readonly number[])[]) =>
    ring.map(v => v.map(n => n.toFixed(2)).join()).sort().join("|");

  const outline = (
    region: Region,
    color: number,
    thick: boolean,
    opacity: number,
    dashed = false,
    /** Rings not in this set are drawn in `only` instead: they exist on one side and not the other. */
    shared?: { keys: Set<string>; only: number; },
    into: THREE.Group = overlay,
  ) => {
    const made: THREE.Material[] = [];
    for (const ring of region.rings) {
      if (ring.length < 2) continue;
      // A region can change by nothing but a hole appearing in it, and a hole drawn in the same
      // colour as the outline it was cut into is invisible. One that exists on one side only is
      // coloured as the addition or removal it is.
      const colour = shared && !shared.keys.has(ringKey(ring)) ? shared.only : color;
      if (thick) {
        const points = ring.flat();
        points.push(...ring[0]);
        const geo = new LineGeometry();
        geo.setPositions(points);
        const mat = new LineMaterial({ color: colour, linewidth: 3, depthTest: false, transparent: true, opacity });
        mat.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
        mat.userData.marker = into !== overlay;
        lineMaterials.push(mat);
        made.push(mat);
        const line = new Line2(geo, mat);
        line.renderOrder = 3;
        into.add(line);
      } else {
        const points = ring.map(([x, y, z]) => new THREE.Vector3(x, y, z));
        const geo = new THREE.BufferGeometry().setFromPoints([...points, points[0].clone()]);
        const line = new THREE.Line(
          geo,
          dashed
            ? new THREE.LineDashedMaterial({ color: colour, depthTest: false, transparent: true, opacity, dashSize: 4, gapSize: 3 })
            : new THREE.LineBasicMaterial({ color: colour, depthTest: false, transparent: true, opacity }),
        );
        if (dashed) line.computeLineDistances();
        line.renderOrder = 2;
        made.push(line.material as THREE.Material);
        into.add(line);
      }
    }
    return made;
  };

  const fill = (region: Region, color: number, opacity: number, into: THREE.Group = overlay) => {
    if ((region.rings[0]?.length ?? 0) < 3) return undefined;
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
    into.add(mesh);
    return mesh.material;
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
      // Which rings the two sides have in common, so the ones only one of them has stand out.
      const beforeKeys = new Set((before?.rings ?? []).map(ringKey));
      const afterKeys = new Set((after?.rings ?? []).map(ringKey));

      if (kind === "removed" || kind === "reshaped") {
        // Dashed, and brighter than it was: a before nobody can pick out is not worth drawing.
        if (before) {
          outline(before, color, false, 0.9, true, kind === "reshaped" ? { keys: afterKeys, only: STATUS_COLOR.removed } : undefined);
        }
        if (before && kind === "removed") fill(before, color, 0.18);
      }
      if (after) {
        outline(
          after,
          color,
          kind !== "unchanged",
          kind === "unchanged" ? 0.35 : 1,
          false,
          kind === "reshaped" ? { keys: beforeKeys, only: STATUS_COLOR.added } : undefined,
        );
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
    /** One dot per pair of ends: a mob given several regions is going to each of them. */
    legs: { from: THREE.Vector3; to: THREE.Vector3; dot: THREE.Object3D; }[];
    /** The regions it left and the ones it was given, each material with the opacity it peaks at. */
    leaving: Faded[];
    arriving: Faded[];
    elapsed: number;
  } | null = null;
  type Faded = { material: THREE.Material; peak: number; };
  const faded = (materials: (THREE.Material | undefined)[]): Faded[] =>
    materials.flatMap(m => (m ? [{ material: m, peak: (m as THREE.Material & { opacity: number; }).opacity }] : []));
  // What rides above each dot: who it is and which way this leg goes. The dot alone said a move
  // happened; with several legs, or several mobs in a row, it did not say whose or to where.
  const [legLabels, setLegLabels] = createSignal<string[]>([]);
  const legRefs: HTMLDivElement[] = [];

  // Whatever is being looked at, drawn on top of everything so it is findable among the rest.
  const marker = new THREE.Group();
  marker.renderOrder = 6;
  createEffect(() => scene().add(marker));
  onCleanup(() => cleanupNode(marker));

  /**
   * The scene carries zone coordinates and flips them on its scale, so anything added to it goes in
   * raw -- as the region outlines do. The camera is not in the scene graph and works in world
   * space, so a point handed to it has to be flipped. Mixing the two puts markers off the map while
   * the camera still goes to the right place, which is exactly how it looked.
   */
  const toWorld = (v: THREE.Vector3) => new THREE.Vector3(v.x, -v.y, -v.z);

  /** A move names its regions joined with ", ", the way the list reads them out. */
  const namesIn = (joined?: string | null) => (joined ? joined.split(", ") : []);

  /**
   * Where a spawn actually stands on one side: its own point, or the middle of each region placing
   * it. Several regions means the server picks one per spawn, so it stands in all of them.
   */
  const standsAt = (side: ZoneSide, id: string, regionNames?: string | null): { at: THREE.Vector3; name: string; }[] => {
    const spawn = side.spawns.find(sp => sp.id === id);
    if (spawn?.at) return [{ at: new THREE.Vector3(spawn.x, spawn.y, spawn.z), name: "its own spot" }];
    return namesIn(regionNames).flatMap(name => {
      const ring = side.regions[name]?.rings[0];
      if (!ring?.length) return [];
      const middle = ring.reduce((sum, [x, y, z]) => sum.add(new THREE.Vector3(x, y, z)), new THREE.Vector3());
      return [{ at: middle.divideScalar(ring.length), name }];
    });
  };

  const ringLine = (ring: readonly (readonly number[])[], colour: number) => {
    const points = ring.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    points.push(points[0].clone());
    return new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: colour, depthTest: false }),
    );
  };

  /** A round sprite, because a default point sprite is a square and a mob is not a cube. */
  const roundDot = (() => {
    let texture: THREE.Texture | undefined;
    return () => {
      if (texture) return texture;
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      texture = new THREE.CanvasTexture(canvas);
      onCleanup(() => texture?.dispose());
      return texture;
    };
  })();

  // The trail arrives on its own clock, after the focus and once the zone's roam file is down.
  const trailDots = new THREE.Group();
  trailDots.renderOrder = 5;
  createEffect(() => scene().add(trailDots));
  onCleanup(() => cleanupNode(trailDots));
  const trailMaterial = new THREE.PointsMaterial({
    color: 0x59f2ff,
    size: 4,
    sizeAttenuation: false,
    depthTest: false,
    map: roundDot(),
    transparent: true,
    opacity: 0.7,
  });
  onCleanup(() => trailMaterial.dispose());
  createEffect(() => {
    for (const old of trailDots.children as THREE.Points[]) old.geometry.dispose();
    trailDots.clear();
    if (!props.trail?.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(props.trail, 3));
    trailDots.add(new THREE.Points(geo, trailMaterial));
  });

  const pin = (at: THREE.Vector3, colour: number) => {
    const group = new THREE.Group();
    const stalk = new THREE.BufferGeometry().setFromPoints([at, at.clone().setY(at.y + 30)]);
    group.add(new THREE.Line(stalk, new THREE.LineBasicMaterial({ color: colour, depthTest: false })));
    const dot = new THREE.BufferGeometry().setFromPoints([at]);
    group.add(new THREE.Points(
      dot,
      new THREE.PointsMaterial({ color: colour, size: 12, sizeAttenuation: false, depthTest: false, map: roundDot(), transparent: true }),
    ));
    return group;
  };

  createEffect(() => {
    const want = props.focus;
    walking = null;
    setLegLabels([]);
    while (marker.children.length) cleanupNode(marker.children.pop()!);
    for (let i = lineMaterials.length; i--;) if (lineMaterials[i].userData.marker) lineMaterials.splice(i, 1);
    if (!want || !controls) return;

    // Scene coordinates are flipped on the scale, so points go in negated on y and z.
    const box = new THREE.Box3();

    if (want.spawn) {
      // A move has two ends and showing one of them explains nothing. A spawn placed by a region
      // has no point of its own -- the region replaced it -- so "where it is" means that region.
      const move = props.diff.moved.find(m => m.id === want.spawn);
      const froms = standsAt(props.base, want.spawn, move?.from);
      const tos = standsAt(props.head, want.spawn, move?.to);
      if (!froms.length && !tos.length) return;

      // Both ends drawn heavy, outline and fill, and handed to the frame loop to cross-fade: the
      // region it left is loud while the dot sets off and gone by the time it arrives, when the
      // one it was given is at full strength.
      const leaving: Faded[] = [];
      const arriving: Faded[] = [];
      for (const name of namesIn(move?.from)) {
        const region = props.base.regions[name];
        if (!region?.rings[0]?.length) continue;
        leaving.push(...faded([...outline(region, STATUS_COLOR.removed, true, 1, false, undefined, marker), fill(region, STATUS_COLOR.removed, 0.35, marker)]));
      }
      for (const name of namesIn(move?.to)) {
        const region = props.head.regions[name];
        if (!region?.rings[0]?.length) continue;
        arriving.push(...faded([...outline(region, STATUS_COLOR.added, true, 1, false, undefined, marker), fill(region, STATUS_COLOR.added, 0.35, marker)]));
      }
      for (const { at } of froms) (marker.add(pin(at, STATUS_COLOR.removed)), box.expandByPoint(at));
      for (const { at } of tos) (marker.add(pin(at, STATUS_COLOR.added)), box.expandByPoint(at));

      // A dot for every way it could have gone: one region to several is a dot to each of them.
      const legs: NonNullable<typeof walking>["legs"] = [];
      const labels: string[] = [];
      for (const { at: from, name: fromName } of froms) {
        for (const { at: to, name: toName } of tos) {
          labels.push(`${move?.name ?? want.spawn} · ${fromName} → ${toName}`);
          // The path it took, faint, so the route is there even between passes of the dot.
          marker.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([from.clone().setY(from.y + 20), to.clone().setY(to.y + 20)]),
            new THREE.LineBasicMaterial({ color: 0xfff066, depthTest: false, transparent: true, opacity: 0.35 }),
          ));
          const dot = new THREE.Points(
            new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]),
            new THREE.PointsMaterial({ color: 0xfff066, size: 16, sizeAttenuation: false, depthTest: false, map: roundDot(), transparent: true }),
          );
          marker.add(dot);
          legs.push({ from: from.clone().setY(from.y + 20), to: to.clone().setY(to.y + 20), dot });
        }
      }
      if (legs.length) {
        walking = { legs, leaving, arriving, elapsed: 0 };
        setLegLabels(labels);
      }
    } else if (want.name) {
      const region = props.head.regions[want.name] ?? props.base.regions[want.name];
      if (!region?.rings[0]?.length) return;
      for (const ring of region.rings) {
        if (ring.length < 2) continue;
        marker.add(ringLine(ring, 0xfff066));
        for (const [x, y, z] of ring) box.expandByPoint(new THREE.Vector3(x, y, z));
      }
    } else {
      return;
    }

    // Close enough that it fills the view rather than merely being in it, keeping whatever angle
    // the camera was already at. Both ends of a move have to fit, however far apart they are.
    const centre = toWorld(box.getCenter(new THREE.Vector3()));
    // Neighbouring regions can be a few yalms apart, and framing exactly that puts the camera on
    // top of one spot with no ground around it to say where it is. A move needs its surroundings
    // more than it needs to fill the frame.
    // A region on its own is the thing being judged, so it fills the frame: a vertex on a wall
    // is a metre wide and the whole point of looking.
    const floor = want.spawn ? 70 : 12;
    const margin = want.spawn ? 2.2 : 1.1;
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, floor);
    const distance = (radius * margin) / Math.tan((camera().fov * Math.PI) / 360);
    const direction = new THREE.Vector3().subVectors(camera().position, controls.target).normalize();
    if (!direction.lengthSq()) direction.set(0, 1, 0);
    controls.target.copy(centre);
    camera().position.copy(centre).addScaledVector(direction, distance);
  });

  onMount(() => {
    const projected = new THREE.Vector3();
    const viewer = createViewer(canvasElement, {
      scene: scene(),
      camera: camera(),
      onFrame: dt => {
        if (walking) {
          const TRAVEL = 1.6, PAUSE = 0.7;
          walking.elapsed = (walking.elapsed + dt) % (TRAVEL + PAUSE);
          const t = Math.min(walking.elapsed / TRAVEL, 1);
          // Eased, because something that sets off and arrives reads as going somewhere, where
          // something at constant speed reads as a moving decoration.
          const eased = t * t * (3 - 2 * t);
          for (const leg of walking.legs) leg.dot.position.lerpVectors(leg.from, leg.to, eased);
          // The region it left gives way as the dot goes; the one it was given takes over.
          for (const { material, peak } of walking.leaving) (material as THREE.Material & { opacity: number; }).opacity = peak * (1 - eased * 0.9);
          for (const { material, peak } of walking.arriving) (material as THREE.Material & { opacity: number; }).opacity = peak * (0.1 + eased * 0.9);
        }
        for (const m of lineMaterials) m.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
      },
      onAfterRender: () => {
        // Each leg's label rides just above its dot, wherever the dot is this frame.
        walking?.legs.forEach((leg, i) => {
          const el = legRefs[i];
          if (!el) return;
          projected.copy(leg.dot.position).set(projected.x, -projected.y, -projected.z).project(camera());
          el.style.display = projected.z < 1 ? "block" : "none";
          el.style.transform = `translate(-50%, -100%) translate(${(projected.x * 0.5 + 0.5) * canvasElement.clientWidth}px, ${
            (-projected.y * 0.5 + 0.5) * canvasElement.clientHeight - 12
          }px)`;
        });
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
      },
    });
    controls = viewer.controls;
    fitCameraToContents(camera(), controls, fn => overlay.children.forEach(fn));

    // Where the cursor meets terrain. Only a real mesh hit counts: empty space has no position.
    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true;
    const mouse = new THREE.Vector2();
    const groundPoint = (ev: MouseEvent) => {
      if (!zoneMesh) return undefined;
      const rect = canvasElement.getBoundingClientRect();
      mouse.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(mouse, camera());
      const hit = raycaster.intersectObject(zoneMesh, true)[0];
      return hit ? scene().worldToLocal(hit.point.clone()) : undefined;
    };
    const onMove = (ev: MouseEvent) => setCursor(groundPoint(ev));
    const onLeave = () => setCursor(undefined);
    const onClick = (ev: MouseEvent) => {
      if (!ev.altKey) return;
      const p = groundPoint(ev);
      if (p) copy(`!pos ${xyz(p)}`);
    };
    canvasElement.addEventListener("mousemove", onMove);
    canvasElement.addEventListener("mouseleave", onLeave);
    canvasElement.addEventListener("click", onClick);

    onCleanup(() => {
      canvasElement.removeEventListener("mousemove", onMove);
      canvasElement.removeEventListener("mouseleave", onLeave);
      canvasElement.removeEventListener("click", onClick);
      viewer.dispose();
    });
  });

  // Only changed regions get a label; naming the unchanged ones would bury the ones that matter.
  const labelled = createMemo(() => Object.entries(statuses()).filter(([, kind]) => kind !== "unchanged"));

  return (
    <div class="relative h-full">
      <canvas class="block w-full h-full outline-none" ref={canvasElement!} />
      {/* The layer ignores the mouse so the camera still drags through it; the labels take it
          back, since a name on the map is the most obvious thing to click. */}
      <div class="absolute inset-0 overflow-hidden pointer-events-none">
        <For each={labelled()}>
          {([name, kind]) => {
            onCleanup(() => labelRefs.delete(name));
            return (
              <div
                ref={el => labelRefs.set(name, el)}
                class="absolute top-0 left-0 hidden whitespace-nowrap text-xs font-bold px-1.5 py-0.5 rounded bg-slate-900/80 pointer-events-auto cursor-pointer hover:bg-slate-800"
                style={{ color: `#${STATUS_COLOR[kind].toString(16)}` }}
                title={`Look at ${name}`}
                onClick={() => props.onPick?.(name)}
              >
                {name}
              </div>
            );
          }}
        </For>
        <For each={legLabels()}>
          {(text, i) => (
            <div
              ref={el => (legRefs[i()] = el)}
              class="absolute top-0 left-0 hidden whitespace-nowrap text-xs px-1.5 py-0.5 rounded bg-slate-900/85 text-slate-100"
            >
              {text}
            </div>
          )}
        </For>
      </div>
      <div class="absolute top-2 left-2 flex gap-3 text-xs bg-slate-900/75 rounded px-2 py-1 pointer-events-none">
        <For each={Object.entries(STATUS_COLOR)}>
          {([kind, color]) => (
            <span style={{ color: `#${color.toString(16)}` }}>
              {kind}
              <Show when={kind === "removed" || kind === "reshaped"}>
                <span class="text-slate-500">(dashed = before, green/red rings = a hole gained or lost)</span>
              </Show>
            </span>
          )}
        </For>
      </div>
      <Show when={cursor()}>
        <div
          class="absolute bottom-2 left-2 font-mono text-xs text-slate-200 bg-slate-900/75 rounded px-2 py-1 cursor-pointer select-none"
          title="Ground position under the cursor. Click to copy, or alt+click the map for !pos"
          onClick={() => copy(xyz(cursor()!))}
        >
          {xyz(cursor()!)}
        </div>
      </Show>
      <Show when={toast()}>
        <div class="absolute bottom-2 right-2 text-xs text-slate-200 bg-slate-900/85 rounded px-2 py-1 pointer-events-none">{toast()}</div>
      </Show>
    </div>
  );
}
