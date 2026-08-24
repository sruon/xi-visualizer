import * as THREE from "three";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { MapControls } from "three/examples/jsm/Addons.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { addMapControls, adjustCameraAspect } from "../graphics/camera";
import { setupBaseScene } from "../graphics/scene";
import { cleanupNode } from "../graphics/util";
import { ColorKind, createZoneMesh, prepareMeshData } from "../graphics/ximesh";
import { ZoneData } from "./zone_model";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

interface PathPoint {
  x: number;
  y: number;
  z: number;
}

interface MobPathData {
  name: string;
  points: PathPoint[];
}

interface PathData {
  [mobId: string]: MobPathData;
}

interface RoamViewerProps {
  zoneData: ZoneData;
  pathData?: PathData;
}

interface MobEntry {
  id: string;
  name: string;
  pointCount: number;
  points: THREE.Points | null;
}

function stringToColor(str: string): THREE.Color {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  let h = (hash & 0xFFFF) / 0xFFFF;
  h = ((h * 0.87) + 0.18) % 1.0;
  return new THREE.Color().setHSL(h, 1.0, 0.65);
}

function createPointMaterial(color: THREE.Color, size: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      pointColor: { value: color },
      pointSize: { value: size },
      opacity: { value: 1.0 },
    },
    vertexShader: `
      uniform float pointSize;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = pointSize;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 pointColor;
      uniform float opacity;
      void main() {
        vec2 center = gl_PointCoord - vec2(0.5);
        float dist = length(center);
        if (dist > 0.5) discard;
        if (dist > 0.35) {
          gl_FragColor = vec4(0.0, 0.0, 0.0, opacity);
        } else {
          gl_FragColor = vec4(pointColor, opacity);
        }
      }
    `,
    transparent: true,
    depthTest: false,
  });
}

export default function RoamViewer(props: RoamViewerProps) {
  let canvasElement: HTMLCanvasElement;
  let controls: MapControls | undefined;
  let rendererRef: THREE.WebGLRenderer | undefined;

  const scene = createMemo(() => setupBaseScene());
  const camera = createMemo(() => {
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 5000);
    cam.position.set(0, 500, 0);
    cam.lookAt(0, 0, 0);
    return cam;
  });

  const [mobEntries, setMobEntries] = createSignal<MobEntry[]>([]);
  const [visibleMobs, setVisibleMobs] = createSignal<Set<string>>(new Set());
  const [searchFilter, setSearchFilter] = createSignal("");
  const [hoveredMob, setHoveredMob] = createSignal<MobEntry | null>(null);
  const [selectedMob, setSelectedMob] = createSignal<MobEntry | null>(null);
  const [tooltipPos, setTooltipPos] = createSignal<{ x: number; y: number } | null>(null);
  const [pointPos, setPointPos] = createSignal<{ x: number; y: number; z: number } | null>(null);

  const activeMob = () => selectedMob() || hoveredMob();

  const filteredMobs = createMemo(() => {
    const filter = searchFilter().toLowerCase();
    if (!filter) return mobEntries();
    return mobEntries().filter(m =>
      m.name.toLowerCase().includes(filter) || m.id.includes(filter)
    );
  });

  createMemo(() => {
    const prep = prepareMeshData(props.zoneData.mesh);
    const mesh = createZoneMesh(props.zoneData.id, props.zoneData.mesh, prep, ColorKind.Materials);
    scene().add(mesh);
    onCleanup(() => {
      scene().remove(mesh);
      cleanupNode(mesh);
    });
    return mesh;
  });

  createEffect(() => {
    const data = props.pathData;
    if (!data) return;

    const entries: MobEntry[] = [];
    const initialVisible = new Set<string>();
    const pointsObjects: THREE.Points[] = [];

    for (const mobId in data) {
      const mob = data[mobId];
      const material = createPointMaterial(stringToColor(mob.name), 6);

      const positions = new Float32Array(mob.points.length * 3);
      let idx = 0;
      for (const p of mob.points) {
        positions[idx++] = p.x;
        positions[idx++] = p.y;
        positions[idx++] = p.z;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

      const points = new THREE.Points(geometry, material);
      points.userData.mobId = mobId;
      scene().add(points);
      pointsObjects.push(points);

      entries.push({
        id: mobId,
        name: mob.name.replaceAll("_", " "),
        pointCount: mob.points.length,
        points,
      });
      initialVisible.add(mobId);
    }

    entries.sort((a, b) => parseInt(a.id) - parseInt(b.id));
    setMobEntries(entries);
    setVisibleMobs(initialVisible);

    onCleanup(() => {
      for (const points of pointsObjects) {
        scene().remove(points);
        points.geometry.dispose();
        (points.material as THREE.Material).dispose();
      }
    });
  });

  createEffect(() => {
    const visible = visibleMobs();
    for (const entry of mobEntries()) {
      if (entry.points) entry.points.visible = visible.has(entry.id);
    }
  });

  createEffect(() => {
    const active = activeMob();
    for (const entry of mobEntries()) {
      if (!entry.points) continue;
      const material = entry.points.material as THREE.ShaderMaterial;
      const isActive = active && entry.id === active.id;
      material.uniforms.pointSize.value = isActive ? 10 : 6;
      material.uniforms.opacity.value = active ? (isActive ? 1.0 : 0.05) : 1.0;
      entry.points.renderOrder = isActive ? 1 : 0;
    }
  });

  const toggleMob = (mobId: string) => {
    setVisibleMobs(prev => {
      const next = new Set(prev);
      next.has(mobId) ? next.delete(mobId) : next.add(mobId);
      return next;
    });
  };

  const centerOnMob = (mobId: string) => {
    const entry = mobEntries().find(m => m.id === mobId);
    if (!entry?.points || !controls) return;

    entry.points.geometry.computeBoundingBox();
    const box = entry.points.geometry.boundingBox;
    if (!box) return;

    const center = new THREE.Vector3();
    box.getCenter(center);

    const offset = new THREE.Vector3().subVectors(camera().position, controls.target);
    controls.target.copy(center);
    camera().position.copy(center).add(offset);

    if (!visibleMobs().has(mobId)) toggleMob(mobId);
  };

  onMount(() => {
    const resizeCanvas = () => {
      const parentRect = canvasElement.parentElement!.getBoundingClientRect();
      canvasElement.width = parentRect.width;
      canvasElement.height = parentRect.height;
    };

    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();

    controls = addMapControls(camera(), canvasElement);
    const renderer = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: true, alpha: true, preserveDrawingBuffer: true });
    rendererRef = renderer;

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 5 };
    const mouse = new THREE.Vector2();

    const onMouseMove = (event: MouseEvent) => {
      const rect = canvasElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera());
      const pointsObjects = mobEntries().filter(e => e.points?.visible).map(e => e.points!);
      const intersects = raycaster.intersectObjects(pointsObjects);

      if (intersects.length > 0) {
        const mobId = intersects[0].object.userData.mobId;
        const entry = mobEntries().find(e => e.id === mobId);
        if (entry) {
          setHoveredMob(entry);
          setTooltipPos({ x: event.clientX, y: event.clientY });
          const p = intersects[0].point;
          setPointPos({ x: p.x, y: p.y, z: p.z });
          return;
        }
      }
      setHoveredMob(null);
      if (!selectedMob()) {
        setTooltipPos(null);
        setPointPos(null);
      }
    };

    canvasElement.addEventListener("mousemove", onMouseMove);

    const onClick = (event: MouseEvent) => {
      const rect = canvasElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera());
      const pointsObjects = mobEntries().filter(e => e.points?.visible).map(e => e.points!);
      const intersects = raycaster.intersectObjects(pointsObjects);

      if (intersects.length > 0) {
        const mobId = intersects[0].object.userData.mobId;
        const entry = mobEntries().find(e => e.id === mobId);
        if (entry) {
          const isDeselect = selectedMob()?.id === entry.id;
          setSelectedMob(isDeselect ? null : entry);
          setTooltipPos({ x: event.clientX, y: event.clientY });
          const p = intersects[0].point;
          setPointPos(isDeselect ? null : { x: p.x, y: p.y, z: p.z });
          return;
        }
      }
      setSelectedMob(null);
      setPointPos(null);
    };

    canvasElement.addEventListener("click", onClick);

    const clock = new THREE.Clock();
    const animate = () => {
      controls?.update(clock.getDelta());
      renderer.setSize(canvasElement.clientWidth, canvasElement.clientHeight, false);
      adjustCameraAspect(camera(), canvasElement);
      renderer.render(scene(), camera());
    };
    renderer.setAnimationLoop(animate);

    onCleanup(() => {
      window.removeEventListener("resize", resizeCanvas);
      canvasElement.removeEventListener("mousemove", onMouseMove);
      canvasElement.removeEventListener("click", onClick);
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
        <button
          class="absolute top-2 right-2 px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-sm"
          onClick={() => {
            if (!rendererRef || !controls) return;

            const box = new THREE.Box3();
            scene().traverse(obj => {
              if (obj instanceof THREE.Mesh) {
                box.expandByObject(obj);
              }
            });
            if (box.isEmpty()) return;

            const zoneCenter = new THREE.Vector3();
            box.getCenter(zoneCenter);

            const cam = camera();
            const prevPos = cam.position.clone();
            const prevTarget = controls.target.clone();

            const size = new THREE.Vector3();
            box.getSize(size);

            const zoneAspect = size.x / size.z;
            const resH = 4096;
            const resW = Math.round(resH * zoneAspect);

            const fov = cam.fov * (Math.PI / 180);
            const verticalFov = fov;
            const horizontalFov = 2 * Math.atan(Math.tan(fov / 2) * zoneAspect);
            const distV = (size.z / 2) / Math.tan(verticalFov / 2);
            const distH = (size.x / 2) / Math.tan(horizontalFov / 2);
            const distance = Math.max(distV, distH) * 1.05;

            const dir = new THREE.Vector3().subVectors(cam.position, controls.target).normalize();
            cam.position.copy(zoneCenter).addScaledVector(dir, distance);
            controls.target.copy(zoneCenter);
            cam.lookAt(zoneCenter);

            const target = new THREE.WebGLRenderTarget(resW, resH);

            const prevAspect = cam.aspect;
            cam.aspect = zoneAspect;
            cam.updateProjectionMatrix();

            rendererRef.setRenderTarget(target);
            rendererRef.render(scene(), cam);
            rendererRef.setRenderTarget(null);

            cam.position.copy(prevPos);
            controls.target.copy(prevTarget);
            cam.aspect = prevAspect;
            cam.updateProjectionMatrix();

            const pixels = new Uint8Array(resW * resH * 4);
            rendererRef.readRenderTargetPixels(target, 0, 0, resW, resH, pixels);
            target.dispose();

            const flipped = new Uint8Array(resW * resH * 4);
            for (let y = 0; y < resH; y++) {
              const srcRow = (resH - 1 - y) * resW * 4;
              const dstRow = y * resW * 4;
              flipped.set(pixels.subarray(srcRow, srcRow + resW * 4), dstRow);
            }

            const imgData = new ImageData(new Uint8ClampedArray(flipped), resW, resH);
            const offscreen = new OffscreenCanvas(resW, resH);
            const ctx = offscreen.getContext("2d")!;
            ctx.putImageData(imgData, 0, 0);

            ctx.font = "bold 64px sans-serif";
            ctx.fillStyle = "white";
            ctx.strokeStyle = "black";
            ctx.lineWidth = 4;
            ctx.textAlign = "left";
            ctx.strokeText(props.zoneData.name, 20, 74);
            ctx.fillText(props.zoneData.name, 20, 74);

            offscreen.convertToBlob({ type: "image/png" }).then(blob => {
              navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            });
          }}
          title="Copy hi-res centered screenshot"
        >
          📋
        </button>
        <Show when={activeMob() && tooltipPos()}>
          <div
            class="fixed bg-slate-900 text-white px-2 py-1 rounded text-sm pointer-events-none z-50"
            style={{ left: `${tooltipPos()!.x + 10}px`, top: `${tooltipPos()!.y + 10}px` }}
          >
            <div class="font-bold">{activeMob()!.name}</div>
            <div class="text-slate-400">{activeMob()!.id}</div>
            <Show when={pointPos()}>
              <div class="text-slate-400 text-xs">
                {pointPos()!.x.toFixed(1)}, {pointPos()!.y.toFixed(1)}, {pointPos()!.z.toFixed(1)}
              </div>
            </Show>
          </div>
        </Show>
      </div>
      <div class="w-64 flex flex-col bg-slate-800 rounded-lg p-2 overflow-hidden">
        <input
          type="text"
          placeholder="Filter mobs..."
          class="w-full px-2 py-1 mb-2 bg-slate-700 rounded text-sm"
          value={searchFilter()}
          onInput={(e) => setSearchFilter(e.currentTarget.value)}
        />
        <div class="flex gap-1 mb-2 text-xs">
          <button class="flex-1 px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded" onClick={() => {
            setVisibleMobs(prev => {
              const next = new Set(prev);
              for (const m of filteredMobs()) next.add(m.id);
              return next;
            });
          }}>
            Show All
          </button>
          <button class="flex-1 px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded" onClick={() => {
            setVisibleMobs(prev => {
              const next = new Set(prev);
              for (const m of filteredMobs()) next.delete(m.id);
              return next;
            });
          }}>
            Hide All
          </button>
        </div>
        <div class="text-xs text-slate-400 mb-1">
          {visibleMobs().size} / {mobEntries().length} visible
        </div>
        <div class="flex-1 overflow-y-auto">
          <For each={filteredMobs()}>
            {(mob) => (
              <div class="flex items-center gap-2 py-1 px-1 hover:bg-slate-700 rounded text-sm">
                <input
                  type="checkbox"
                  checked={visibleMobs().has(mob.id)}
                  onChange={() => toggleMob(mob.id)}
                  class="rounded cursor-pointer"
                />
                <div class="flex-1 min-w-0 cursor-pointer" onClick={() => centerOnMob(mob.id)}>
                  <div class="truncate" title={mob.name}>{mob.name}</div>
                  <div class="text-xs text-slate-500">{mob.id}</div>
                </div>
                <span class="text-xs text-slate-500">{mob.pointCount}</span>
                <button class="px-1 text-slate-400 hover:text-white" onClick={() => centerOnMob(mob.id)} title="Center">⌖</button>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
