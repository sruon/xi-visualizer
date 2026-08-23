// node scripts/shot_points.mjs points.json out_dir [scale]
//
// Renders a top down view of each zone with the given positions marked as red circles, one PNG per
// group. points.json is [{ zone, group, kind?, x, y, z }] with raw game coordinates; the scene
// carries the y/z flip already, so nothing is converted here. scale multiplies the resolution.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const [pointsFile, outDir, scaleArg] = process.argv.slice(2);
if (!pointsFile || !outDir) {
  console.error("usage: node scripts/shot_points.mjs points.json out_dir [scale]");
  process.exit(1);
}
const scale = Number(scaleArg) || 2;

const BROWSERS = [
  process.env.BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const browserPath = BROWSERS.find(p => existsSync(p));
if (!browserPath) {
  console.error("No browser found. Set BROWSER to a chrome or edge executable.");
  process.exit(1);
}

const points = JSON.parse(readFileSync(pointsFile, "utf8"));
const groups = new Map();
for (const p of points) {
  const key = p.group ?? String(p.zone);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(p);
}
// Zones cost several MB and a decompress each, so do every group of a zone while it is loaded.
const ordered = [...groups.entries()].sort((a, b) => a[1][0].zone - b[1][0].zone);
mkdirSync(outDir, { recursive: true });

// A dev server is enough - the mesh files are served straight out of public/.
const PORT = 5189;
const base = process.env.URL || `http://localhost:${PORT}/xi-visualizer/`;
let server;
if (!process.env.URL) {
  server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
  process.on("exit", () => server.kill());
  await new Promise(r => setTimeout(r, 4000));
}

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1500, deviceScaleFactor: scale });
page.on("pageerror", e => console.log("[pageerror]", e.message.split("\n")[0]));

let loadedZone;
for (const [group, groupPoints] of ordered) {
  const zone = groupPoints[0].zone;
  if (zone !== loadedZone) {
    await page.goto(`${base}#/zone/${zone}`, { waitUntil: "domcontentloaded" });
    // The mesh is a few MB and decompresses in the page, so wait for it rather than for the route.
    await page.waitForFunction(() => window.__zoneView?.scene.children.some(c => c.isMesh && c.visible), { timeout: 120000 });
    loadedZone = zone;
  }

  const title = [
    await page.evaluate(() => [...document.querySelectorAll("h1")].pop()?.textContent.replace(/\s*\(\d+\)$/, "")),
    groupPoints[0].kind,
  ].filter(Boolean).join(" - ");

  await page.evaluate((pts, scale, title) => {
    const { THREE, scene, camera, controls, renderer } = window.__zoneView;
    // Square canvas with the panels out of the way: this is a map, not a screenshot of the editor.
    const canvas = renderer.domElement;
    canvas.parentElement.style.height = "1400px";
    for (const el of canvas.parentElement.children) {
      if (el !== canvas && el.id !== "shot-title") el.style.display = "none";
    }
    let heading = document.getElementById("shot-title");
    if (!heading) {
      heading = document.createElement("div");
      heading.id = "shot-title";
      heading.style.cssText =
        "position:absolute;top:0;left:0;right:0;text-align:center;padding:12px;font:600 34px sans-serif;color:#fff;text-shadow:0 2px 6px #000";
      canvas.parentElement.appendChild(heading);
    }
    heading.textContent = title;
    renderer.setPixelRatio(scale);
    renderer.setSize(renderer.domElement.clientWidth, renderer.domElement.clientHeight, false);

    for (const old of scene.children.filter(c => c.userData.marker)) {
      scene.remove(old);
      old.geometry.dispose();
    }

    // World space is the scene flipped on y and z, which is where the camera lives. The frame is the
    // whole zone mesh, not just the points, so every map reads as the zone it belongs to.
    const box = new THREE.Box3();
    const zoneMesh = scene.children.find(c => c.isMesh && c.visible && !c.userData.marker);
    box.setFromObject(zoneMesh);
    for (const p of pts) box.expandByPoint(new THREE.Vector3(p.x, -p.y, -p.z));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const height = renderer.domElement.clientHeight || 1;
    const aspect = (renderer.domElement.clientWidth || 1) / height;
    const dist = Math.max(size.z / 2 / tan, size.x / 2 / tan / aspect, 30) * 1.15;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();

    // Radius in world units that lands on a constant size on screen whatever the zone measures.
    const radius = (dist * tan) / 90;
    const geo = new THREE.CircleGeometry(radius, 24).rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xFF1F3D, side: THREE.DoubleSide, depthTest: false });
    for (const p of pts) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.x, p.y, p.z);
      mesh.renderOrder = 1; // depthTest is off so nodes under a ledge still show on the map
      mesh.userData.marker = true;
      scene.add(mesh);
    }

    camera.position.set(center.x, center.y + dist, center.z + 0.001);
    controls.target.copy(center);
    controls.update();
  }, groupPoints, scale, title);

  await new Promise(r => setTimeout(r, 500));
  const out = `${outDir}/${group}.png`;
  await (await page.$("canvas")).screenshot({ path: out });
  console.log(`${groupPoints.length} points -> ${out}`);
}

await browser.close();
server?.kill();
