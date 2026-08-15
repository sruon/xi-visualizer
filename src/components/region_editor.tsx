import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { Line2, LineGeometry, LineMaterial, MapControls } from "three/examples/jsm/Addons.js";
import { addMapControls, adjustCameraAspect, fitCameraToContents } from "../graphics/camera";
import { setupBaseScene } from "../graphics/scene";
import { cleanupNode } from "../graphics/util";
import { ColorKind, colorMesh, createZoneMesh, prepareMeshData } from "../graphics/ximesh";
import type { RoamData } from "../pages/regions";
import { containsXZ, regionAt, regionHue, simplifyRing, validate } from "../regions";
import type { Finding, Region, RegionSet, Spawn, Vertex } from "../regions";
import type { ZoneData } from "./zone_model";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

interface RegionEntry extends Region {
  name: string;
}

interface Handle {
  ring: number;
  idx: number;
  mid: boolean;
}

interface RegionEditorProps {
  zoneData: ZoneData;
  spawns: Spawn[];
  regions: RegionSet;
  /** Overrides the assignments carried on the spawns themselves, for restoring a draft. */
  assign?: Record<string, string>;
  roam?: RoamData;
  onChange: (regions: RegionSet, assign: Record<string, string>) => void;
}

const GOLDEN = 0.61803398875; // successive regions land far apart on the colour wheel

const POINT_VERTEX = `
  uniform float pointSize;
  attribute float mid;
  varying vec3 vColor;
  varying float vMid;
  void main() {
    vColor = color;
    vMid = mid;
    gl_PointSize = pointSize * (mid > 0.5 ? 0.65 : 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Spawns are round with a dark rim so a stack of them still reads as separate dots.
const spawnMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { pointSize: { value: 8 } },
    vertexShader: POINT_VERTEX,
    fragmentShader: `
      varying vec3 vColor;
      varying float vMid;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        gl_FragColor = d > 0.34 ? vec4(0.04, 0.04, 0.06, 1.0) : vec4(vColor, 1.0);
        #include <colorspace_fragment>
      }
    `,
    vertexColors: true,
    depthTest: false,
  });

// Roam trails: small dots for the whole zone, and when one mob is focused, only its points survive
// — as large pills, so you can see at a glance whether a polygon covers where it actually goes.
const roamMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { focused: { value: 0 } },
    vertexShader: `
      uniform float focused;
      attribute float big;
      varying vec3 vColor;
      varying float vBig;
      void main() {
        vColor = color;
        vBig = big;
        gl_PointSize = big > 0.5 ? 9.0 : 2.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float focused;
      varying vec3 vColor;
      varying float vBig;
      void main() {
        if (focused > 0.5 && vBig < 0.5) discard;
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        if (vBig > 0.5) {
          // White core, dark rim: the focused trail has to read on top of its own region's fill,
          // which is the one colour it can never borrow.
          gl_FragColor = d > 0.34 ? vec4(0.02, 0.02, 0.04, 1.0) : vec4(1.0, 1.0, 1.0, 1.0);
        } else {
          gl_FragColor = vec4(vColor, 0.6);
        }
        #include <colorspace_fragment>
      }
    `,
    vertexColors: true,
    transparent: true,
    depthTest: false,
  });

// Polygon handles are squares in the region colour: corners filled, edge midpoints hollow.
const handleMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { pointSize: { value: 12 } },
    vertexShader: POINT_VERTEX,
    fragmentShader: `
      varying vec3 vColor;
      varying float vMid;
      void main() {
        vec2 d = abs(gl_PointCoord - vec2(0.5));
        float edge = max(d.x, d.y);
        if (vMid > 0.5) {
          if (edge < 0.3) discard;
          gl_FragColor = vec4(vColor, 1.0);
        } else {
          gl_FragColor = edge > 0.35 ? vec4(0.04, 0.04, 0.06, 1.0) : vec4(vColor, 1.0);
        }
        #include <colorspace_fragment>
      }
    `,
    vertexColors: true,
    depthTest: false,
  });

export default function RegionEditor(props: RegionEditorProps) {
  let canvasElement: HTMLCanvasElement;
  let controls: MapControls | undefined;

  const scene = createMemo(() => setupBaseScene());
  const camera = createMemo(() => {
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 20000);
    cam.position.set(0, 500, 0);
    cam.lookAt(0, 0, 0);
    return cam;
  });

  const [regions, setRegions] = createSignal<RegionEntry[]>(
    Object.entries(props.regions).map(([name, r]) => ({ name, ...r })),
  );
  const [assign, setAssign] = createSignal<Record<string, string>>(
    props.assign ?? Object.fromEntries(props.spawns.filter(s => s.region).map(s => [s.id, s.region!])),
  );
  const [activeName, setActiveName] = createSignal<string | null>(null);
  const [mode, setMode] = createSignal<"select" | "draw">("select");
  const [filter, setFilter] = createSignal("");
  const [hideAssigned, setHideAssigned] = createSignal(true);
  const [tab, setTab] = createSignal<"regions" | "unassigned" | "review">("regions");
  const [terrainColors, setTerrainColors] = createSignal(true);
  const [hover, setHover] = createSignal<{ spawn: Spawn; x: number; y: number; } | null>(null);
  const [cursor, setCursor] = createSignal<THREE.Vector3 | undefined>();
  const [rowFocus, setRowFocus] = createSignal<string | null>(null);
  const [pinnedId, setPinnedId] = createSignal<string | null>(null);

  // Hovering a dot on the map or a row in the member list picks out that mob's roam trail; clicking
  // the row pins it, so the trail stays put while you reshape the polygon around it.
  const focusId = () => hover()?.spawn.id ?? rowFocus() ?? pinnedId();
  const pinnedSpawn = () => props.spawns.find(s => s.id === pinnedId());

  const active = () => regions().find(r => r.name === activeName());
  const matches = (s: Spawn) => {
    const f = filter().toLowerCase();
    return !f || s.name.toLowerCase().includes(f) || s.id.includes(f);
  };
  const asSet = (list: RegionEntry[]): RegionSet => Object.fromEntries(list.map(r => [r.name, { rings: r.rings }]));

  // Colour by position, so each region added is visibly distinct from the last. Regions the list
  // no longer holds (a spawn pointing at a deleted one) fall back to the name hash.
  const hues = createMemo(() => {
    const map: Record<string, number> = {};
    regions().forEach((r, i) => (map[r.name] = (i * GOLDEN + 0.11) % 1));
    return map;
  });
  const hueOf = (name: string) => hues()[name] ?? regionHue(name);
  const colorOf = (name: string) => new THREE.Color().setHSL(hueOf(name), 0.9, 0.6);
  const cssOf = (name: string) => `hsl(${(hueOf(name) * 360).toFixed(0)} 90% 60%)`;

  createEffect(() => props.onChange(asSet(regions()), assign()));

  const spawnCounts = createMemo(() => {
    const counts: Record<string, number> = {};
    for (const name of Object.values(assign())) counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  });

  const findings = createMemo(() => validate(asSet(regions()), props.spawns, assign()));

  // --- history ---
  interface Snapshot {
    regions: RegionEntry[];
    assign: Record<string, string>;
    activeName: string | null;
  }
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];
  const snap = (): Snapshot => ({ regions: regions(), assign: assign(), activeName: activeName() });
  const restore = (s: Snapshot) => {
    setRegions(s.regions);
    setAssign(s.assign);
    setActiveName(s.activeName);
  };

  // Snapshots are taken at operation boundaries, so a whole vertex drag collapses into one step.
  const checkpoint = () => {
    undoStack.push(snap());
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  };
  const undo = () => {
    const prev = undoStack.pop();
    if (prev) (redoStack.push(snap()), restore(prev));
  };
  const redo = () => {
    const next = redoStack.pop();
    if (next) (undoStack.push(snap()), restore(next));
  };

  const editActive = (fn: (r: RegionEntry) => void) => {
    const name = activeName();
    setRegions(rs =>
      rs.map(r => {
        if (r.name !== name) return r;
        const copy: RegionEntry = { name: r.name, rings: r.rings.map(ring => ring.map(v => [...v] as Vertex)) };
        fn(copy);
        return copy;
      })
    );
  };

  const addRegion = () => {
    checkpoint();
    let n = regions().length + 1;
    while (regions().some(r => r.name === `region_${n}`)) n++;
    const name = `region_${n}`;
    setRegions(rs => [...rs, { name, rings: [[]] }]);
    setActiveName(name);
    setMode("draw");
  };

  // Returns false when the new name is empty or taken, so the input can snap back.
  const renameRegion = (from: string, raw: string) => {
    const to = raw.trim().replace(/[^A-Za-z0-9_]/g, "_");
    if (!to || regions().some(r => r.name === to && r.name !== from)) return false;
    if (to === from) return true;
    checkpoint();
    setRegions(rs => rs.map(r => (r.name === from ? { ...r, name: to } : r)));
    setAssign(a => Object.fromEntries(Object.entries(a).map(([id, n]) => [id, n === from ? to : n])));
    if (activeName() === from) setActiveName(to);
    return true;
  };

  const deleteRegion = (name: string) => {
    checkpoint();
    setRegions(rs => rs.filter(r => r.name !== name));
    setAssign(a => Object.fromEntries(Object.entries(a).filter(([, n]) => n !== name)));
    if (activeName() === name) setActiveName(null);
  };

  const assignInside = (remove: boolean) => {
    const r = active();
    if (!r) return;
    checkpoint();
    const set = asSet(regions());
    setAssign(a => {
      const next = { ...a };
      for (const s of props.spawns) {
        // A spawn whose region already replaced its `at:` has no position to test.
        if (!s.at || !matches(s) || regionAt(set, s.x, s.z, s.y) !== r.name) continue;
        if (remove) delete next[s.id];
        else next[s.id] = r.name;
      }
      return next;
    });
  };

  // Keeps the current view angle and distance, just slides the camera over. Scene is flipped on y/z.
  const flyTo = (x: number, y: number, z: number) => {
    if (!controls) return;
    const center = new THREE.Vector3(x, -y, -z);
    const offset = new THREE.Vector3().subVectors(camera().position, controls.target);
    controls.target.copy(center);
    camera().position.copy(center).add(offset);
  };

  const centerOn = (name: string) => {
    const r = regions().find(x => x.name === name);
    if (!r?.rings[0]?.length) return;
    const box = new THREE.Box3();
    for (const [x, y, z] of r.rings[0]) box.expandByPoint(new THREE.Vector3(x, y, z));
    const center = box.getCenter(new THREE.Vector3());
    flyTo(center.x, center.y, center.z);
    setActiveName(name);
  };

  // Spawns with no region yet, template-grouped by sort so runs of the same mob read together.
  const unassigned = createMemo(() =>
    props.spawns
      .filter(s => !assign()[s.id] && matches(s))
      .sort((a, b) => a.name.localeCompare(b.name) || Number(a.id) - Number(b.id))
  );

  const members = createMemo(() => {
    const name = activeName();
    if (!name) return [];
    return props.spawns.filter(s => assign()[s.id] === name && matches(s));
  });

  const unassign = (id: string) => {
    checkpoint();
    setAssign(a => {
      const next = { ...a };
      delete next[id];
      return next;
    });
  };

  // --- three.js ---
  const overlay = new THREE.Group();
  const labelRefs = new Map<string, HTMLDivElement>();
  const handleMap: Handle[] = [];
  const activeLineMaterials: LineMaterial[] = [];
  const drawnSpawns: number[] = [];
  let handlePoints: THREE.Points | undefined;
  let spawnPoints: THREE.Points | undefined;
  let roamPoints: THREE.Points | undefined;
  let lastFocusRange: [number, number] | undefined;
  let zoneMesh: THREE.Mesh | undefined;
  let meshPrep: ReturnType<typeof prepareMeshData> | undefined;
  let drag: { ring: number; idx: number; } | null = null;
  let spawnDrag: { spawn: Spawn; line: THREE.Line; } | null = null;

  createMemo(() => {
    const prep = prepareMeshData(props.zoneData.mesh);
    const mesh = createZoneMesh(props.zoneData.id, props.zoneData.mesh, prep, ColorKind.Materials);
    // ximesh writes byte colours without flagging them normalized, which blows them out to white.
    // Fixing that plus dimming the material keeps the terrain readable *under* the overlay.
    (mesh.geometry.getAttribute("color") as THREE.BufferAttribute).normalized = true;
    (mesh.material as THREE.MeshBasicMaterial).color.setScalar(0.75);
    zoneMesh = mesh;
    meshPrep = prep;
    scene().add(mesh);
    scene().add(overlay);
    onCleanup(() => {
      scene().remove(mesh);
      cleanupNode(mesh);
    });
  });

  createEffect(() => {
    const kind = terrainColors() ? ColorKind.Materials : ColorKind.None;
    if (zoneMesh && meshPrep) colorMesh(zoneMesh, meshPrep, kind);
  });

  // Recorded roam trails, drawn under everything so a polygon can be checked against where the
  // mobs actually went.
  createEffect(() => {
    const data = props.roam;
    roamPoints = undefined;
    if (!data) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(data.positions.length), 3));
    geo.setAttribute("big", new THREE.BufferAttribute(new Float32Array(data.count), 1));
    const points = new THREE.Points(geo, roamMaterial());
    points.renderOrder = 0;
    roamPoints = points;
    scene().add(points);
    onCleanup(() => {
      scene().remove(points);
      geo.dispose();
      (points.material as THREE.Material).dispose();
    });
  });

  // The active region's own mobs light up in its colour; everything else stays a dim backdrop.
  createEffect(() => {
    const data = props.roam;
    const points = roamPoints;
    if (!data || !points) return;
    const a = assign();
    const act = activeName();
    const colors = points.geometry.getAttribute("color") as THREE.BufferAttribute;
    // Trails fade back only when the selected region actually has mobs to contrast against —
    // otherwise dimming them all would just turn the overlay into black specks.
    const highlighting = !!act && Object.keys(data.ranges).some(id => a[id] === act);
    const dim = highlighting ? new THREE.Color(0.22, 0.28, 0.36) : new THREE.Color(0.55, 0.7, 0.85);
    const lit = act ? colorOf(act) : dim;
    for (const [mobId, [start, count]] of Object.entries(data.ranges)) {
      const c = act && a[mobId] === act ? lit : dim;
      for (let i = 0; i < count; i++) colors.setXYZ(start + i, c.r, c.g, c.b);
    }
    colors.needsUpdate = true;
  });

  // Focusing one mob only touches its own slice of the buffer, so it can follow the cursor.
  createEffect(() => {
    const data = props.roam;
    const points = roamPoints;
    if (!data || !points) return;
    const id = focusId();
    const big = points.geometry.getAttribute("big") as THREE.BufferAttribute;
    for (const range of [lastFocusRange, id ? data.ranges[id] : undefined]) {
      if (!range) continue;
      const value = range === data.ranges[id!] ? 1 : 0;
      for (let i = range[0]; i < range[0] + range[1]; i++) big.setX(i, value);
    }
    lastFocusRange = id ? data.ranges[id] : undefined;
    big.needsUpdate = true;
    (points.material as THREE.ShaderMaterial).uniforms.focused.value = lastFocusRange ? 1 : 0;
  });

  // Rebuilt whenever what is drawn changes; drawnSpawns maps geometry index -> props.spawns index,
  // so hidden spawns are neither drawn nor pickable.
  createEffect(() => {
    const a = assign();
    const hide = hideAssigned();
    const gray = new THREE.Color(0.9, 0.9, 0.9);

    drawnSpawns.length = 0;
    const pos: number[] = [];
    const col: number[] = [];
    props.spawns.forEach((s, i) => {
      const name = a[s.id];
      if (!s.at) return; // its region places it now, there is no dot to draw
      if (name && hide) return;
      drawnSpawns.push(i);
      pos.push(s.x, s.y, s.z);
      const c = name ? colorOf(name) : gray;
      const dim = matches(s) ? 1 : 0.2;
      col.push(c.r * dim, c.g * dim, c.b * dim);
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
    geo.setAttribute("mid", new THREE.BufferAttribute(new Float32Array(drawnSpawns.length), 1));
    const points = new THREE.Points(geo, spawnMaterial());
    points.renderOrder = 4;
    spawnPoints = points;
    scene().add(points);
    onCleanup(() => {
      scene().remove(points);
      geo.dispose();
      (points.material as THREE.Material).dispose();
    });
  });

  createEffect(() => {
    const list = regions();
    const activeRegion = active();
    while (overlay.children.length) {
      const child = overlay.children.pop() as THREE.Mesh;
      child.geometry?.dispose();
      (child.material as THREE.Material)?.dispose();
    }
    handleMap.length = 0;
    activeLineMaterials.length = 0;
    handlePoints = undefined;

    for (const r of list) {
      const isActive = r.name === activeRegion?.name;
      // Editing one polygon means the others are only in the way.
      if (activeRegion && !isActive) continue;
      const color = colorOf(r.name);

      // Fill follows the floor: triangulate on x/z (as earcut does) and keep each vertex's own y.
      if ((r.rings[0]?.length ?? 0) >= 3) {
        const flat = [r.rings[0], ...r.rings.slice(1).filter(h => h.length >= 3)];
        const faces = THREE.ShapeUtils.triangulateShape(
          flat[0].map(([x, , z]) => new THREE.Vector2(x, -z)),
          flat.slice(1).map(h => h.map(([x, , z]) => new THREE.Vector2(x, -z))),
        );
        const verts = flat.flat();
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts.flat()), 3));
        geo.setIndex(faces.flat());
        const fill = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: isActive ? 0.45 : 0.3, side: THREE.DoubleSide, depthTest: false }),
        );
        fill.renderOrder = 1;
        overlay.add(fill);
      }

      for (const ring of r.rings) {
        if (ring.length < 2) continue;
        if (isActive) {
          // WebGL ignores LineBasicMaterial.linewidth, so the selected outline is drawn as Line2,
          // which builds screen-space quads and can actually be thick.
          const pts = ring.flat();
          pts.push(...ring[0]); // Line2 has no loop mode
          const geo = new LineGeometry();
          geo.setPositions(pts);
          const mat = new LineMaterial({ color: color.getHex(), linewidth: 3, depthTest: false });
          mat.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
          activeLineMaterials.push(mat);
          const line = new Line2(geo, mat);
          line.renderOrder = 3;
          overlay.add(line);
        } else {
          const geo = new THREE.BufferGeometry().setFromPoints(ring.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
          const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 }));
          line.renderOrder = 2;
          overlay.add(line);
        }
      }
    }

    if (activeRegion) {
      const outlineColor = colorOf(activeRegion.name);
      // Hole handles take the region's opposite hue, so it is obvious which ring you are dragging.
      const holeColor = new THREE.Color().setHSL((hueOf(activeRegion.name) + 0.5) % 1, 0.9, 0.6);
      const pos: number[] = [];
      const col: number[] = [];
      const mid: number[] = [];
      activeRegion.rings.forEach((ring, ri) => {
        const c = ri === 0 ? outlineColor : holeColor;
        ring.forEach(([x, y, z], vi) => {
          pos.push(x, y, z);
          col.push(c.r, c.g, c.b);
          mid.push(0);
          handleMap.push({ ring: ri, idx: vi, mid: false });
        });
        if (ring.length >= 3) {
          ring.forEach(([x, y, z], vi) => {
            const [nx, ny, nz] = ring[(vi + 1) % ring.length];
            pos.push((x + nx) / 2, (y + ny) / 2, (z + nz) / 2);
            col.push(c.r, c.g, c.b);
            mid.push(1);
            handleMap.push({ ring: ri, idx: vi, mid: true });
          });
        }
      });
      if (pos.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
        geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
        geo.setAttribute("mid", new THREE.BufferAttribute(new Float32Array(mid), 1));
        handlePoints = new THREE.Points(geo, handleMaterial());
        handlePoints.renderOrder = 5;
        overlay.add(handlePoints);
      }
    }
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
    raycaster.params.Points = { threshold: 2 };
    const mouse = new THREE.Vector2();
    let downAt: { x: number; y: number; } | null = null;

    const aim = (ev: MouseEvent) => {
      const rect = canvasElement.getBoundingClientRect();
      mouse.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(mouse, camera());
    };

    // Point picking works in world units, so convert the grab radius from pixels at the
    // current zoom — otherwise a fixed radius is unhittable when zoomed out.
    const grabRadius = (pixels: number) => {
      const cam = camera();
      const dist = cam.position.distanceTo(controls!.target);
      const worldPerPixel = (2 * Math.tan((cam.fov * Math.PI) / 360) * dist) / canvasElement.clientHeight;
      raycaster.params.Points!.threshold = pixels * worldPerPixel;
    };

    const pickSpawn = (): Spawn | undefined => {
      if (!spawnPoints) return undefined;
      grabRadius(8);
      const hit = raycaster.intersectObject(spawnPoints)[0];
      return hit?.index === undefined ? undefined : props.spawns[drawnSpawns[hit.index]];
    };

    const pickHandle = (): Handle | null => {
      if (!handlePoints) return null;
      grabRadius(12);
      const hit = raycaster.intersectObject(handlePoints)[0];
      return hit?.index !== undefined ? handleMap[hit.index] : null;
    };

    // Zone coordinates under the cursor. Vertices take their height from the terrain here, which
    // is what makes the polygon describe a floor.
    const pickZonePoint = (fallbackY = 0): THREE.Vector3 | null => {
      const hit = zoneMesh && raycaster.intersectObject(zoneMesh, true)[0];
      if (hit) return scene().worldToLocal(hit.point.clone());
      // Scene is flipped on y/z, so a zone plane at h sits at world y = -h.
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), fallbackY);
      const world = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      return world ? scene().worldToLocal(world) : null;
    };

    const lastY = (r?: RegionEntry) => r?.rings.flat().at(-1)?.[1] ?? 0;

    const removeVertex = (handle: Handle) =>
      editActive(r => {
        r.rings[handle.ring].splice(handle.idx, 1);
        if (handle.ring > 0 && r.rings[handle.ring].length < 3) r.rings.splice(handle.ring, 1);
      });

    const onContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
      aim(ev);
      const handle = pickHandle();
      if (!handle || handle.mid) return; // midpoints are not stored, so there is nothing to remove
      checkpoint();
      removeVertex(handle);
    };

    const onMouseDown = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      downAt = { x: ev.clientX, y: ev.clientY };
      aim(ev);
      const handle = pickHandle();

      if (!handle) {
        // Dragging a spawn dot into a polygon assigns it to that region.
        const spawn = pickSpawn();
        if (!spawn) return;
        const start = new THREE.Vector3(spawn.x, spawn.y, spawn.z);
        const geo = new THREE.BufferGeometry().setFromPoints([start, start.clone()]);
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
        line.renderOrder = 6;
        scene().add(line);
        spawnDrag = { spawn, line };
        controls!.enabled = false;
        return;
      }

      checkpoint();
      if (ev.altKey && !handle.mid) {
        removeVertex(handle);
        downAt = null;
        return;
      }
      if (handle.mid) {
        const p = pickZonePoint(lastY(active()));
        editActive(r => {
          const ring = r.rings[handle.ring];
          const a = ring[handle.idx];
          const b = ring[(handle.idx + 1) % ring.length];
          const mid: Vertex = p ? [p.x, p.y, p.z] : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
          ring.splice(handle.idx + 1, 0, mid);
        });
        drag = { ring: handle.ring, idx: handle.idx + 1 };
      } else {
        drag = { ring: handle.ring, idx: handle.idx };
      }
      setHover(null); // otherwise a stale hover keeps overriding the pinned trail mid-drag
      controls!.enabled = false;
      ev.preventDefault();
    };

    const onMouseMove = (ev: MouseEvent) => {
      aim(ev);
      // Ground position under the cursor, for comparing against the game. Only when the ray really
      // hits terrain — the plane fallback would report coordinates for empty space.
      const ground = zoneMesh && raycaster.intersectObject(zoneMesh, true)[0];
      setCursor(ground ? scene().worldToLocal(ground.point.clone()) : undefined);

      if (drag) {
        const p = pickZonePoint(lastY(active()));
        if (p) editActive(r => (r.rings[drag!.ring][drag!.idx] = [p.x, p.y, p.z]));
        return;
      }
      if (spawnDrag) {
        const p = pickZonePoint(spawnDrag.spawn.y);
        if (p) {
          const pos = spawnDrag.line.geometry.getAttribute("position") as THREE.BufferAttribute;
          pos.setXYZ(1, p.x, p.y, p.z);
          pos.needsUpdate = true;
        }
        return;
      }
      const spawn = pickSpawn();
      setHover(spawn ? { spawn, x: ev.clientX, y: ev.clientY } : null);
    };

    const endSpawnDrag = (ev: MouseEvent) => {
      if (!spawnDrag) return;
      const { spawn, line } = spawnDrag;
      spawnDrag = null;
      setHover(null);
      scene().remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();

      if (!downAt || Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) <= 3) return; // a click, not a drag
      aim(ev);
      const p = pickZonePoint(spawn.y);
      const act = active();
      // Only regions you can see can be dropped onto.
      const target = !p ? null : act ? (containsXZ(act, p.x, p.z) ? act.name : null) : regionAt(asSet(regions()), p.x, p.z, spawn.y);
      if (!target) return;
      checkpoint();
      setAssign(a => ({ ...a, [spawn.id]: target }));
    };

    const onMouseUp = (ev: MouseEvent) => {
      endSpawnDrag(ev);
      drag = null;
      controls!.enabled = true;
    };

    const onClick = (ev: MouseEvent) => {
      if (!downAt || Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 3) return;
      aim(ev);
      if (pickHandle()) return;

      if (mode() === "draw") {
        const r = active();
        const p = pickZonePoint(lastY(r));
        if (!p || !r) return;
        checkpoint();
        editActive(c => c.rings[c.rings.length - 1].push([p.x, p.y, p.z]));
        return;
      }

      // Dots only take the click when there is a region to assign them to; otherwise it falls
      // through to picking a region, so a dot can't block selecting the polygon under it.
      const spawn = pickSpawn();
      const name = activeName();
      if (spawn && name) {
        checkpoint();
        setAssign(a => {
          const next = { ...a };
          if (next[spawn.id] === name) delete next[spawn.id];
          else next[spawn.id] = name;
          return next;
        });
        return;
      }

      // With one region selected the others are hidden, so only it can be clicked: anywhere else
      // clears the selection and releases a pinned trail. With none selected, any polygon picks up.
      const p = pickZonePoint();
      const act = active();
      if (act) {
        if (!p || !containsXZ(act, p.x, p.z)) {
          setActiveName(null);
          setPinnedId(null);
        }
        return;
      }
      setActiveName((p && regionAt(asSet(regions()), p.x, p.z, p.y)) ?? null);
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement)?.tagName === "INPUT") return;
      if (ev.ctrlKey || ev.metaKey) {
        const key = ev.key.toLowerCase();
        if (key === "z" && !ev.shiftKey) return (ev.preventDefault(), undo());
        if (key === "y" || (key === "z" && ev.shiftKey)) return (ev.preventDefault(), redo());
        return;
      }
      if (ev.key !== "Escape" && ev.key !== "Enter") return;
      if (mode() !== "draw") return;
      editActive(r => {
        if (r.rings.length > 1 && r.rings[r.rings.length - 1].length < 3) r.rings.pop();
      });
      setMode("select");
    };

    canvasElement.addEventListener("mousedown", onMouseDown);
    canvasElement.addEventListener("mousemove", onMouseMove);
    canvasElement.addEventListener("mouseup", onMouseUp);
    canvasElement.addEventListener("click", onClick);
    canvasElement.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown);

    if (spawnPoints) fitCameraToContents(camera(), controls, fn => fn(spawnPoints!));

    const clock = new THREE.Clock();
    const projected = new THREE.Vector3();
    const placeLabels = () => {
      const only = activeName();
      for (const r of regions()) {
        const el = labelRefs.get(r.name);
        if (!el) continue;
        const ring = r.rings[0] ?? [];
        if (ring.length < 3 || (only && r.name !== only)) {
          el.style.display = "none";
          continue;
        }
        let x = 0, y = 0, z = 0;
        for (const v of ring) (x += v[0], y += v[1], z += v[2]);
        // Scene is flipped on y/z, so zone coordinates negate on the way to world space.
        projected.set(x / ring.length, -y / ring.length, -z / ring.length).project(camera());
        el.style.display = projected.z < 1 ? "block" : "none";
        el.style.transform = `translate(-50%, -50%) translate(${(projected.x * 0.5 + 0.5) * canvasElement.clientWidth}px, ${
          (-projected.y * 0.5 + 0.5) * canvasElement.clientHeight
        }px)`;
      }
    };

    renderer.setAnimationLoop(() => {
      controls?.update(clock.getDelta());
      renderer.setSize(canvasElement.clientWidth, canvasElement.clientHeight, false);
      adjustCameraAspect(camera(), canvasElement);
      for (const m of activeLineMaterials) m.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
      renderer.render(scene(), camera());
      placeLabels();
    });

    onCleanup(() => {
      window.removeEventListener("resize", resizeCanvas);
      window.removeEventListener("keydown", onKeyDown);
      canvasElement.removeEventListener("mousedown", onMouseDown);
      canvasElement.removeEventListener("mousemove", onMouseMove);
      canvasElement.removeEventListener("mouseup", onMouseUp);
      canvasElement.removeEventListener("click", onClick);
      canvasElement.removeEventListener("contextmenu", onContextMenu);
      renderer.setAnimationLoop(null);
      renderer.dispose();
      controls?.dispose();
      cleanupNode(scene());
    });
  });

  const jumpTo = (f: Finding) => {
    if (f.spawnId) {
      const s = props.spawns.find(x => x.id === f.spawnId);
      if (s) flyTo(s.x, s.y, s.z);
      if (f.region && regions().some(r => r.name === f.region)) setActiveName(f.region);
      return;
    }
    if (f.region) centerOn(f.region);
  };

  const vertexCount = (r: RegionEntry) => r.rings[0]?.length ?? 0;

  return (
    <div class="flex gap-4" style={{ height: "78vh" }}>
      <div class="flex-1 relative">
        <canvas class="block w-full h-full outline-none" ref={canvasElement!} />
        <div class="absolute inset-0 overflow-hidden pointer-events-none">
          <For each={regions()}>
            {r => {
              onCleanup(() => labelRefs.delete(r.name));
              return (
                <div
                  ref={el => labelRefs.set(r.name, el)}
                  class="absolute top-0 left-0 hidden whitespace-nowrap text-xs font-bold px-1.5 py-0.5 rounded bg-slate-900/75"
                  style={{ color: cssOf(r.name) }}
                >
                  {r.name} <span class="text-slate-400 font-normal">{spawnCounts()[r.name] ?? 0}</span>
                </div>
              );
            }}
          </For>
        </div>
        <div class="absolute top-2 left-2 text-xs text-slate-300 bg-slate-900/70 rounded px-2 py-1 pointer-events-none">
          <Show
            when={mode() === "draw"}
            fallback={<>drag handles to reshape · right-click one to remove it · drag a spawn into a region to assign it · ctrl+z undoes</>}
          >
            drawing <b>{activeName()}</b> — click to add vertices, Enter/Esc when done
          </Show>
          <Show when={pinnedSpawn()}>
            <span class="ml-2 text-white">
              · holding <b>{pinnedSpawn()!.name}</b> {pinnedSpawn()!.id} — click it again to release
            </span>
          </Show>
        </div>
        <Show when={cursor()}>
          <div
            class="absolute bottom-2 left-2 font-mono text-xs text-slate-200 bg-slate-900/75 rounded px-2 py-1 cursor-pointer select-none"
            title="Ground position under the cursor — click to copy"
            onClick={() => navigator.clipboard.writeText([cursor()!.x, cursor()!.y, cursor()!.z].map(n => n.toFixed(3)).join(" "))}
          >
            {cursor()!.x.toFixed(3)} {cursor()!.y.toFixed(3)} {cursor()!.z.toFixed(3)}
          </div>
        </Show>
        <Show when={hover()}>
          <div
            class="fixed bg-slate-900 text-white px-2 py-1 rounded text-xs pointer-events-none z-50"
            style={{ left: `${hover()!.x + 12}px`, top: `${hover()!.y + 12}px` }}
          >
            <div class="font-bold">{hover()!.spawn.name}</div>
            <div class="text-slate-400">{hover()!.spawn.id}</div>
            <div class="text-slate-400">
              {hover()!.spawn.x.toFixed(1)}, {hover()!.spawn.y.toFixed(1)}, {hover()!.spawn.z.toFixed(1)}
            </div>
            <div style={{ color: assign()[hover()!.spawn.id] ? cssOf(assign()[hover()!.spawn.id]) : "#888" }}>
              {assign()[hover()!.spawn.id] ?? "unassigned"}
            </div>
            <Show when={props.roam?.ranges[hover()!.spawn.id]}>
              <div class="text-slate-400">{props.roam!.ranges[hover()!.spawn.id][1]} roam points</div>
            </Show>
          </div>
        </Show>
      </div>

      <div class="w-80 flex flex-col bg-slate-800 rounded-lg p-2 overflow-hidden text-sm">
        <div class="flex gap-1 mb-2">
          <button
            class="flex-1 px-2 py-1 rounded"
            classList={{ "bg-slate-600": tab() === "regions", "bg-slate-700 text-slate-400": tab() !== "regions" }}
            onClick={() => setTab("regions")}
          >
            Regions ({regions().length})
          </button>
          <button
            class="flex-1 px-2 py-1 rounded"
            classList={{ "bg-slate-600": tab() === "unassigned", "bg-slate-700 text-slate-400": tab() !== "unassigned" }}
            onClick={() => setTab("unassigned")}
          >
            Unmapped ({props.spawns.length - Object.keys(assign()).length})
          </button>
          <button
            class="flex-1 px-2 py-1 rounded"
            classList={{ "bg-slate-600": tab() === "review", "bg-slate-700 text-slate-400": tab() !== "review" }}
            onClick={() => setTab("review")}
          >
            Review ({findings().filter(f => f.level !== "info").length})
          </button>
        </div>

        <Show when={tab() === "unassigned"}>
          <input
            type="text"
            placeholder="Filter (template or id)..."
            class="w-full px-2 py-1 mb-2 bg-slate-700 rounded"
            value={filter()}
            onInput={e => setFilter(e.currentTarget.value)}
          />
          <div class="text-xs text-slate-400 mb-1">
            <Show when={active()} fallback={<>select a region to assign these to it</>}>
              click one to assign it to <span style={{ color: cssOf(activeName()!) }}>{activeName()}</span>
            </Show>
          </div>
          <div class="flex-1 overflow-y-auto">
            <For each={unassigned()} fallback={<div class="text-emerald-500 p-2">Every spawn is mapped.</div>}>
              {s => (
                <div
                  class="flex items-center gap-2 py-0.5 px-1 rounded hover:bg-slate-700 text-xs"
                  classList={{ "cursor-pointer": !!active() }}
                  onMouseEnter={() => setRowFocus(s.id)}
                  onMouseLeave={() => setRowFocus(null)}
                  onClick={() => {
                    const name = activeName();
                    if (!name) return;
                    checkpoint();
                    setAssign(a => ({ ...a, [s.id]: name }));
                  }}
                >
                  <span class="flex-1 truncate" title={s.name}>{s.name}</span>
                  <span class="text-slate-500">{s.id}</span>
                  <Show when={s.at} fallback={<span class="px-1 text-slate-600" title="No position in mobs.yaml">·</span>}>
                    <button class="px-1 text-slate-400 hover:text-white" title="Center" onClick={e => (e.stopPropagation(), flyTo(s.x, s.y, s.z))}>⌖</button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={tab() === "review"}>
          <ReviewList findings={findings()} onJump={jumpTo} />
        </Show>

        <Show when={tab() === "regions"}>
          <div class="flex gap-1 mb-2">
            <button class="flex-1 px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded" onClick={addRegion}>+ Region</button>
            <button
              class="px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded disabled:opacity-40 disabled:text-slate-300"
              disabled={!active()}
              onClick={() => {
                checkpoint();
                editActive(r => r.rings.push([]));
                setMode("draw");
              }}
              title="Cut a hole in the active region"
            >
              + Hole
            </button>
            <button
              class="px-2 py-1 rounded disabled:opacity-40 disabled:text-slate-300"
              classList={{ "bg-emerald-600 hover:bg-emerald-500": mode() === "draw", "bg-slate-600 hover:bg-slate-500": mode() !== "draw" }}
              disabled={!active()}
              onClick={() => setMode(m => (m === "draw" ? "select" : "draw"))}
            >
              {mode() === "draw" ? "Done" : "Draw"}
            </button>
          </div>

          <label class="flex items-center gap-2 mb-1 text-xs text-slate-400 cursor-pointer">
            <input type="checkbox" checked={hideAssigned()} onChange={e => setHideAssigned(e.currentTarget.checked)} />
            hide assigned spawns ({props.spawns.length - Object.keys(assign()).length} left)
          </label>
          <label class="flex items-center gap-2 mb-2 text-xs text-slate-400 cursor-pointer">
            <input type="checkbox" checked={terrainColors()} onChange={e => setTerrainColors(e.currentTarget.checked)} />
            terrain materials
          </label>

          <div class="flex-1 overflow-y-auto">
            <For each={regions()} fallback={<div class="text-slate-500 p-2">No regions yet.</div>}>
              {r => (
                <div
                  class="flex items-center gap-2 py-1 px-1 rounded cursor-pointer hover:bg-slate-700"
                  classList={{ "bg-slate-700": r.name === activeName() }}
                  onClick={() => setActiveName(r.name)}
                >
                  <span class="w-3 h-3 rounded-full shrink-0" style={{ background: cssOf(r.name) }} />
                  <input
                    type="text"
                    class="flex-1 min-w-0 bg-transparent px-1 rounded outline-none hover:bg-slate-600 focus:bg-slate-900"
                    value={r.name}
                    title="Click to rename"
                    onClick={e => e.stopPropagation()}
                    onFocus={() => setActiveName(r.name)}
                    onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                    onChange={e => {
                      if (!renameRegion(r.name, e.currentTarget.value)) e.currentTarget.value = r.name;
                    }}
                  />
                  <span class="text-xs text-slate-400">
                    {vertexCount(r)}v{r.rings.length > 1 ? `+${r.rings.length - 1}h` : ""} · {spawnCounts()[r.name] ?? 0}
                  </span>
                  <button class="px-1 text-slate-400 hover:text-white" title="Center" onClick={e => (e.stopPropagation(), centerOn(r.name))}>⌖</button>
                  <button class="text-slate-400 hover:text-red-400" onClick={e => (e.stopPropagation(), deleteRegion(r.name))}>✕</button>
                </div>
              )}
            </For>
          </div>

          <Show when={active()}>
            <div class="border-t border-slate-700 mt-2 pt-2 space-y-2">
              <input
                type="text"
                placeholder="Filter spawns (template or id)..."
                class="w-full px-2 py-1 bg-slate-700 rounded"
                value={filter()}
                onInput={e => setFilter(e.currentTarget.value)}
              />
              <div class="flex gap-1">
                <button class="flex-1 px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded text-xs" onClick={() => assignInside(false)}>
                  Assign inside
                </button>
                <button class="flex-1 px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded text-xs" onClick={() => assignInside(true)}>
                  Unassign inside
                </button>
                <button
                  class="px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded text-xs"
                  title="Drop vertices that barely change the shape"
                  onClick={() => {
                    checkpoint();
                    editActive(r => (r.rings = r.rings.map(ring => simplifyRing(ring))));
                  }}
                >
                  Simplify
                </button>
              </div>
              <div class="text-xs text-slate-400">
                {spawnCounts()[active()!.name] ?? 0} assigned{filter() && ` · ${members().length} shown`}
              </div>
              <div class="max-h-48 overflow-y-auto">
                <For each={members()} fallback={<div class="text-xs text-slate-500 px-1">Nothing assigned yet.</div>}>
                  {s => (
                    <div
                      class="flex items-center gap-2 py-0.5 px-1 rounded hover:bg-slate-700 text-xs cursor-pointer"
                      classList={{ "bg-slate-600 hover:bg-slate-600": s.id === pinnedId() }}
                      title="Click to keep this mob's roam trail on screen"
                      onMouseEnter={() => setRowFocus(s.id)}
                      onMouseLeave={() => setRowFocus(null)}
                      onClick={() => setPinnedId(id => (id === s.id ? null : s.id))}
                    >
                      <span class="flex-1 truncate" title={s.name}>{s.name}</span>
                      <span class="text-slate-500">{s.id}</span>
                      <Show when={s.at} fallback={<span class="px-1 text-slate-600" title="Placed by the region, no fixed point">·</span>}>
                        <button class="px-1 text-slate-400 hover:text-white" title="Center" onClick={() => flyTo(s.x, s.y, s.z)}>⌖</button>
                      </Show>
                      <button class="text-slate-400 hover:text-red-400" title="Unassign" onClick={() => unassign(s.id)}>✕</button>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function ReviewList(props: { findings: Finding[]; onJump: (f: Finding) => void; }) {
  const color = { error: "text-red-400", warn: "text-amber-400", info: "text-slate-400" };
  return (
    <div class="flex-1 overflow-y-auto">
      <For each={props.findings} fallback={<div class="text-emerald-500 p-2">Nothing to flag.</div>}>
        {f => (
          <div class="py-1 px-1 rounded hover:bg-slate-700 cursor-pointer text-xs" onClick={() => props.onJump(f)}>
            <span class={color[f.level]}>●</span> <span class="text-slate-300">{f.text}</span>
            <Show when={f.region && !f.spawnId}>
              <span class="text-slate-500">— {f.region}</span>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
