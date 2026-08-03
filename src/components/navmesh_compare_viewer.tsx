import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import * as THREE from "three";
import { addMapControls } from "../graphics/camera";
import { buildNavMeshGroup, NavMeshBuildOptions, parseNavMesh } from "../graphics/navmesh";
import { setupBaseScene } from "../graphics/scene";
import { cleanupNode } from "../graphics/util";

interface CompareProps {
  navA: ArrayBuffer;
  navB: ArrayBuffer;
  labelA: string;
  labelB: string;
  repo: string;
}

// Two navmesh panes rendered with a SINGLE shared camera + controls, so panning /
// rotating / zooming either side moves both in lockstep. Each pane reuses the same
// buildNavMeshGroup as the standalone Navmesh viewer, with a shared toggle set.
export default function NavMeshCompareViewer(props: CompareProps) {
  let leftCanvas!: HTMLCanvasElement;
  let rightCanvas!: HTMLCanvasElement;
  let wrapper!: HTMLDivElement;
  let controls: ReturnType<typeof addMapControls> | undefined;

  const parsedA = createMemo(() => parseNavMesh(props.navA));
  const parsedB = createMemo(() => parseNavMesh(props.navB));

  const [colorByComponent, setColorByComponent] = createSignal(true);
  const [colorByTile, setColorByTile] = createSignal(false);
  const [showOffMesh, setShowOffMesh] = createSignal(true);
  const [showEdges, setShowEdges] = createSignal(true);
  const [opacity, setOpacity] = createSignal(1);
  const [copied, setCopied] = createSignal(false);

  const sceneA = createMemo(() => setupBaseScene());
  const sceneB = createMemo(() => setupBaseScene());
  const camera = createMemo(() => {
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 5000);
    cam.position.set(0, 500, 0);
    cam.lookAt(0, 0, 0);
    return cam;
  });

  const opts = (): NavMeshBuildOptions => ({
    showSurface: true,
    showEdges: showEdges(),
    colorByTile: colorByTile(),
    colorByComponent: colorByComponent(),
    showOffMesh: showOffMesh(),
    opacity: opacity(),
  });

  // Rebuild each pane's group whenever the parse or a toggle changes.
  createEffect(() => {
    const group = buildNavMeshGroup(parsedA(), opts());
    sceneA().add(group);
    onCleanup(() => {
      sceneA().remove(group);
      cleanupNode(group);
    });
  });

  createEffect(() => {
    const group = buildNavMeshGroup(parsedB(), opts());
    sceneB().add(group);
    onCleanup(() => {
      sceneB().remove(group);
      cleanupNode(group);
    });
  });

  // Frame the shared camera to a scene's navmesh extent (undoing the (1,-1,-1) flip).
  const fitToView = (scene: THREE.Scene) => {
    if (!controls) {
      return;
    }

    const box = new THREE.Box3();
    scene.traverse(obj => {
      if (obj.name === "navmesh-surface" || obj.name === "navmesh-edges") {
        box.expandByObject(obj);
      }
    });
    if (box.isEmpty()) {
      return;
    }

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    center.y = -center.y;
    center.z = -center.z;

    const cam = camera();
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = (maxDim / 2 / Math.tan((cam.fov * Math.PI) / 360)) * 1.2;
    const dir = new THREE.Vector3().subVectors(cam.position, controls.target).normalize();
    if (dir.lengthSq() === 0) {
      dir.set(0, 1, 0.0001).normalize();
    }

    cam.position.copy(center).addScaledVector(dir, dist);
    controls.target.copy(center);
    cam.lookAt(center);
    controls.update();
  };

  onMount(() => {
    // preserveDrawingBuffer so the screenshot composite can read back both canvases.
    const rendererA = new THREE.WebGLRenderer({ canvas: leftCanvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    const rendererB = new THREE.WebGLRenderer({ canvas: rightCanvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    // Controls live on the wrapper spanning both panes, so a drag on either syncs both.
    controls = addMapControls(camera(), wrapper);

    let raf = 0;
    const clock = new THREE.Clock();
    const loop = () => {
      controls!.update(clock.getDelta());
      const w = leftCanvas.clientWidth;
      const h = leftCanvas.clientHeight;
      if (w > 0 && h > 0) {
        camera().aspect = w / h;
        camera().updateProjectionMatrix();
        rendererA.setSize(w, h, false);
        rendererB.setSize(rightCanvas.clientWidth, rightCanvas.clientHeight, false);
        rendererA.render(sceneA(), camera());
        rendererB.render(sceneB(), camera());
      }

      raf = requestAnimationFrame(loop);
    };

    loop();
    queueMicrotask(() => fitToView(sceneA()));

    onCleanup(() => {
      cancelAnimationFrame(raf);
      controls?.dispose();
      rendererA.dispose();
      rendererB.dispose();
      cleanupNode(sceneA());
      cleanupNode(sceneB());
    });
  });

  // Composite both panes + a caption (repo / ref A / ref B) into one PNG and download it.
  const screenshot = () => {
    const lc = leftCanvas;
    const rc = rightCanvas;
    const gap = 8;
    const headerH = 62;
    const w = lc.width + gap + rc.width;
    const h = headerH + Math.max(lc.height, rc.height);
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "bold 20px system-ui, sans-serif";
    ctx.fillText(props.repo, 12, 20);
    ctx.font = "15px system-ui, sans-serif";
    ctx.fillStyle = "#34d399";
    ctx.fillText(`A  ${props.labelA}`, 12, 46);
    ctx.fillStyle = "#38bdf8";
    ctx.fillText(`B  ${props.labelB}`, lc.width + gap + 6, 46);

    ctx.drawImage(lc, 0, headerH);
    ctx.drawImage(rc, lc.width + gap, headerH);
    ctx.strokeStyle = "#334155";
    ctx.beginPath();
    ctx.moveTo(lc.width + gap / 2, headerH);
    ctx.lineTo(lc.width + gap / 2, h);
    ctx.stroke();

    const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
    const zone = props.labelA.split(" · ").pop() ?? "zone";
    const refA = props.labelA.split(" · ")[0];
    const refB = props.labelB.split(" · ")[0];
    const download = (blob: Blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${safe(zone)}__${safe(refA)}_vs_${safe(refB)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };

    out.toBlob(async blob => {
      if (!blob) {
        return;
      }

      // Copy the image to the clipboard for pasting straight into a PR / issue.
      try {
        if (!navigator.clipboard?.write) {
          throw new Error("no clipboard");
        }

        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        download(blob); // clipboard unavailable/denied — fall back to a file
      }
    }, "image/png");
  };

  const check = "accent-emerald-500";
  const stat = (p: ReturnType<typeof parsedA>) =>
    `${p.stats.totalPolys.toLocaleString()} polys · ${p.components.islands.toLocaleString()} islands (largest ${p.components.largestPct.toFixed(1)}%) · ${p.stats.offMeshLinks.toLocaleString()} off-mesh`;

  return (
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-4 text-sm bg-slate-800 rounded-lg px-3 py-2">
        <label class="flex items-center gap-1.5">
          <input type="checkbox" class={check} checked={colorByComponent()} onChange={e => setColorByComponent(e.currentTarget.checked)} />
          Color by island
        </label>
        <label class="flex items-center gap-1.5">
          <input type="checkbox" class={check} checked={colorByTile()} onChange={e => setColorByTile(e.currentTarget.checked)} />
          Color by tile
        </label>
        <label class="flex items-center gap-1.5">
          <input type="checkbox" class={check} checked={showOffMesh()} onChange={e => setShowOffMesh(e.currentTarget.checked)} />
          Off-mesh links
        </label>
        <label class="flex items-center gap-1.5">
          <input type="checkbox" class={check} checked={showEdges()} onChange={e => setShowEdges(e.currentTarget.checked)} />
          Poly edges
        </label>
        <label class="flex items-center gap-1.5">
          Opacity
          <input type="range" min="0.2" max="1" step="0.05" value={opacity()} onInput={e => setOpacity(Number(e.currentTarget.value))} />
        </label>
        <button class="ml-auto px-3 py-1 bg-slate-700 hover:bg-slate-600 rounded text-sm" onClick={screenshot}>
          {copied() ? "Copied!" : "Copy image"}
        </button>
      </div>

      <div ref={wrapper!} class="flex gap-1 touch-none" style={{ height: "72vh" }}>
        <div class="flex-1 flex flex-col min-w-0">
          <div class="text-xs text-slate-300 px-1 pb-1 truncate">
            <span class="text-emerald-400 font-semibold">A</span> {props.labelA}
            <span class="text-slate-500"> — {stat(parsedA())}</span>
          </div>
          <canvas ref={leftCanvas!} class="block w-full flex-1 rounded outline-none bg-slate-900" />
        </div>
        <div class="flex-1 flex flex-col min-w-0">
          <div class="text-xs text-slate-300 px-1 pb-1 truncate">
            <span class="text-sky-400 font-semibold">B</span> {props.labelB}
            <span class="text-slate-500"> — {stat(parsedB())}</span>
          </div>
          <canvas ref={rightCanvas!} class="block w-full flex-1 rounded outline-none bg-slate-900" />
        </div>
      </div>
    </div>
  );
}
