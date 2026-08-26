// Headless renderer for the viewers in src/graphics: drives the built app in a real browser and
// writes PNGs. One entry point for what used to be seven near-identical scripts.
//
//   node scripts/shot.mjs <command> [args]
//
// See scripts/README.md for what each command produces.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BROWSERS = [
  process.env.BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const settle = ms => new Promise(r => setTimeout(r, ms));
const win = p => p.replace(/\\/g, "/"); // puppeteer wants forward slashes, the shell gives backslashes

let server;
let url;

/** The app to drive: URL if one is already running, otherwise a dev server started here. */
async function appUrl() {
  if (url) return url;
  if (process.env.URL) return (url = process.env.URL);
  const port = 5189;
  // A dev server is enough -- the mesh files are served straight out of public/.
  server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(port), "--strictPort"], { stdio: "ignore" });
  process.on("exit", () => server.kill());
  await settle(4000);
  return (url = `http://localhost:${port}/xi-visualizer/`);
}

/** A browser on the app's front page, with page errors echoed to the console. */
async function openApp({ width = 1200, height = 820, scale = 1, hash = "" } = {}) {
  const executablePath = BROWSERS.find(p => existsSync(p));
  if (!executablePath) {
    console.error("No browser found. Set BROWSER to a chrome or edge executable.");
    process.exit(1);
  }
  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    // swiftshader so this works on a machine with no GPU worth the name, ignore-gpu-blocklist so
    // it works on one that has a GPU the browser distrusts.
    args: [
      "--no-sandbox",
      "--use-gl=swiftshader",
      "--enable-unsafe-swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      `--window-size=${width},${height}`,
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  page.on("pageerror", e => console.log("[pageerror]", e.message.split("\n")[0]));
  await page.goto((await appUrl()) + hash, { waitUntil: hash ? "domcontentloaded" : "networkidle0" });
  return { browser, page };
}

/** Click a link in the top nav by its text, the way somebody would. */
const nav = (page, name) => page.evaluate(n => [...document.querySelectorAll("a")].find(a => a.textContent.trim() === n)?.click(), name);

/** Read a side panel's text; the class is how each page's panel is told apart. */
const panelText = (page, selector) => page.evaluate(s => document.querySelector(s)?.innerText ?? "", selector);

/** Drag across the canvas, which is what tilts the camera off straight-down. */
async function drag(page, dx, dy, steps = 12) {
  const box = await (await page.$("canvas")).boundingBox();
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps });
  await page.mouse.up();
  await settle(400);
}

const commands = {
  /** zone <out.png> <file.nav> [tilt] -- one navmesh, the stats panel echoed to stdout. */
  async zone([out, navFile, tilt]) {
    const { browser, page } = await openApp();
    await nav(page, "Navmesh");
    await settle(600);
    await (await page.$('input[type="file"]')).uploadFile(win(navFile));
    await settle(1600);
    console.log("PANEL:", (await panelText(page, ".w-56")).split("\n").slice(0, 6).join(" | "));
    if (tilt === "tilt") await drag(page, 30, -150);
    await page.screenshot({ path: out });
    console.log("shot ->", out);
    await browser.close();
  },

  /** offmesh <out.png> <file.nav> [x,y,z] -- islands coloured apart, zoomed in on a coordinate. */
  async offmesh([out, navFile, coord]) {
    const { browser, page } = await openApp();
    await nav(page, "Navmesh");
    await settle(600);
    await (await page.$('input[type="file"]')).uploadFile(win(navFile));
    await settle(1500);
    console.log("PANEL:", (await panelText(page, ".w-56")).split("\n").slice(0, 6).join(" | "));
    await page.evaluate(() => {
      const l = [...document.querySelectorAll("label")].find(x => /Color by island/i.test(x.textContent));
      const cb = l?.querySelector("input");
      if (cb && !cb.checked) cb.click();
    });
    if (coord) {
      await page.evaluate(c => {
        const inp = [...document.querySelectorAll('input[type="text"]')].pop();
        // Setting .value directly does not tell the framework anything; the native setter plus an
        // input event is what a keystroke looks like from the outside.
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        s.call(inp, c);
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      }, coord);
      await page.evaluate(() => [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "Go")?.click());
      await settle(700);
    }
    const box = await (await page.$("canvas")).boundingBox();
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel({ deltaY: -200 });
    }
    await settle(400);
    await page.screenshot({ path: out });
    console.log("shot ->", out);
    await browser.close();
  },

  /** diff <out.png> <a.nav> <b.nav> -- two navmeshes compared, the diff panel echoed to stdout. */
  async diff([out, a, b]) {
    const { browser, page } = await openApp();
    await nav(page, "Navmesh Diff");
    await settle(800);
    const inputs = await page.$$('input[type="file"]');
    await inputs[0].uploadFile(win(a));
    await inputs[1].uploadFile(win(b));
    await settle(2500);
    console.log("PANEL:\n" + (await panelText(page, ".w-64") || "(no panel)"));
    if (await page.$("canvas")) await drag(page, 25, -80, 8);
    await page.screenshot({ path: out });
    console.log("shot ->", out);
    await browser.close();
  },

  /** batch <baseDir> <mineDir> <outDir> -- the diff of every zone in both folders, plus a manifest. */
  async batch([baseDir, mineDir, outDir]) {
    mkdirSync(outDir, { recursive: true });
    const zones = readdirSync(mineDir)
      .filter(f => f.endsWith(".nav"))
      .map(f => f.replace(/\.nav$/, ""))
      .filter(z => existsSync(`${baseDir}/${z}.nav`))
      .sort();
    console.log(`${zones.length} zones in both sets`);

    const { browser, page } = await openApp({ width: 1100, height: 760 });
    await nav(page, "Navmesh Diff");
    await settle(600);

    const manifest = [];
    let i = 0;
    for (const zone of zones) {
      i++;
      try {
        // Reset inputs if a diff is already loaded.
        const loadOthers = await page.$$eval("button", bs => {
          const b = bs.find(x => x.textContent.trim() === "Load others");
          if (b) b.click();
          return !!b;
        });
        if (loadOthers) await settle(200);

        const inputs = await page.$$('input[type="file"]');
        await inputs[0].uploadFile(`${baseDir}/${zone}.nav`);
        await inputs[1].uploadFile(`${mineDir}/${zone}.nav`);
        await settle(1400);

        // Read stats from the side panel.
        const stats = await page.evaluate(() => {
          const t = document.querySelector(".w-64")?.innerText || "";
          const links = /off-mesh links:\s*([\d,]+)\s*→\s*([\d,]+)/.exec(t);
          const triA = /added surface tris:\s*([\d,]+)/.exec(t);
          const triR = /removed surface tris:\s*([\d,]+)/.exec(t);
          return {
            addedLinks: links ? links[2].replace(/,/g, "") : "?",
            addedTris: triA ? triA[1].replace(/,/g, "") : "?",
            removedTris: triR ? triR[1].replace(/,/g, "") : "?",
          };
        });

        const box = await (await page.$("canvas")).boundingBox();
        await page.screenshot({ path: `${outDir}/${zone}.png`, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
        manifest.push({ zone, ...stats });
        if (i % 20 === 0) console.log(`  ${i}/${zones.length} (${zone})`);
      } catch (e) {
        console.log(`  ERR ${zone}: ${e.message}`);
        manifest.push({ zone, error: e.message });
      }
    }

    writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
    console.log(`done: ${manifest.length} zones -> ${outDir}`);
    await browser.close();
  },

  /**
   * points <points.json> <outDir> [scale] -- a top down map per group with the given positions
   * marked, points.json being [{ zone, group, kind?, x, y, z }] in raw game coordinates. The scene
   * carries the y/z flip already, so nothing is converted here.
   */
  async points([pointsFile, outDir, scaleArg]) {
    const scale = Number(scaleArg) || 2;
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

    const { browser, page } = await openApp({ width: 1400, height: 1500, scale, hash: "#/" });
    const base = await appUrl();

    let loadedZone;
    for (const [group, groupPoints] of ordered) {
      const zone = groupPoints[0].zone;
      if (zone !== loadedZone) {
        await page.goto(`${base}#/zone/${zone}`, { waitUntil: "domcontentloaded" });
        // The mesh is a few MB and decompresses in the page, so wait for it rather than the route.
        await page.waitForFunction(() => window.__zoneView?.scene.children.some(c => c.isMesh && c.visible), { timeout: 120000 });
        loadedZone = zone;
      }

      const title = [
        await page.evaluate(() => [...document.querySelectorAll("h1")].pop()?.textContent.replace(/\s*\(\d+\)$/, "")),
        groupPoints[0].kind,
      ].filter(Boolean).join(" - ");

      await page.evaluate(
        (pts, scale, title) => {
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
        },
        groupPoints,
        scale,
        title,
      );

      await settle(500);
      const out = `${outDir}/${group}.png`;
      await (await page.$("canvas")).screenshot({ path: out });
      console.log(`${groupPoints.length} points -> ${out}`);
    }

    await browser.close();
  },

  /** gallery <diffsDir> -- an HTML contact sheet over what `batch` wrote. No browser involved. */
  async gallery([dir]) {
    const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8"));
    const pngs = new Set(readdirSync(dir).filter(f => f.endsWith(".png")));

    // Sort: most off-mesh links added first (the biggest diffs to review), then name.
    const rows = manifest
      .filter(m => pngs.has(`${m.zone}.png`))
      .map(m => ({ ...m, added: Number(m.addedLinks) || 0 }))
      .sort((a, b) => b.added - a.added || a.zone.localeCompare(b.zone));

    const totalLinks = rows.reduce((s, r) => s + r.added, 0);
    const cells = rows.map(r => `
  <figure>
    <a href="${r.zone}.png" target="_blank"><img src="${r.zone}.png" loading="lazy" alt="${r.zone}"></a>
    <figcaption>
      <b>${r.zone}</b>
      <span class="links">+${r.added.toLocaleString()} links</span>
      ${(Number(r.addedTris) || Number(r.removedTris)) ? `<span class="geo">Δgeo +${r.addedTris}/-${r.removedTris} tris</span>` : ""}
    </figcaption>
  </figure>`).join("");

    const html = `<!doctype html><html><head><meta charset="utf8"><title>Navmesh diff: base → off-mesh</title>
<style>
  body { background:#0b1220; color:#dbe4f0; font:14px system-ui,sans-serif; margin:0; padding:16px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:#8aa; margin-bottom:16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:12px; }
  figure { margin:0; background:#141d2e; border-radius:8px; overflow:hidden; }
  img { width:100%; display:block; background:#1b2536; aspect-ratio:1100/760; object-fit:cover; }
  figcaption { padding:6px 8px; font-size:12px; display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; }
  .links { color:#35d07f; }
  .geo { color:#ffb454; }
</style></head><body>
<h1>Navmesh diff — base (A) → off-mesh build (B)</h1>
<div class="sub">${rows.length} zones · ${totalLinks.toLocaleString()} off-mesh links added total · green dots/lines = added off-mesh links · sorted by links added. Click a tile to enlarge.</div>
<div class="grid">${cells}</div>
</body></html>`;

    writeFileSync(`${dir}/index.html`, html);
    console.log(`gallery: ${dir}/index.html (${rows.length} zones, ${totalLinks} links)`);
  },

  /** check -- does the diff page come up at all. The first thing to run when a shot comes out empty. */
  async check() {
    const { browser, page } = await openApp();
    await nav(page, "Navmesh Diff");
    await settle(1000);
    console.log("inputs:", (await page.$$("input[type=file]")).length);
    console.log("body:", (await page.evaluate(() => document.body.innerText)).slice(0, 180).replace(/\n/g, " | "));
    await browser.close();
  },
};

const [command, ...args] = process.argv.slice(2);
if (!commands[command]) {
  console.error(`usage: node scripts/shot.mjs <${Object.keys(commands).join("|")}> [args]  -- see scripts/README.md`);
  process.exit(1);
}
await commands[command](args);
server?.kill();
