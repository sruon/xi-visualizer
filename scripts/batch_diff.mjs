import puppeteer from "puppeteer-core";
import { readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";

// Batch-render the A(base) -> B(mine) navmesh diff for every zone that exists in
// both folders, into per-zone PNGs + a manifest for the HTML contact sheet.
// Usage: node _batch_diff.mjs <baseDir> <mineDir> <outDir>
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const [baseDir, mineDir, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const zones = readdirSync(mineDir)
  .filter(f => f.endsWith(".nav"))
  .map(f => f.replace(/\.nav$/, ""))
  .filter(z => existsSync(`${baseDir}/${z}.nav`))
  .sort();
console.log(`${zones.length} zones in both sets`);

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1100,760"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 760 });
page.on("pageerror", e => console.log("[pageerror]", e.message));

await page.goto("http://localhost:3000/xi-visualizer/", { waitUntil: "networkidle0" });
await page.evaluate(() => [...document.querySelectorAll("a")].find(a => a.textContent.trim() === "Navmesh Diff")?.click());
await new Promise(r => setTimeout(r, 600));

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
    if (loadOthers) await new Promise(r => setTimeout(r, 200));

    const inputs = await page.$$('input[type="file"]');
    await inputs[0].uploadFile(`${baseDir}/${zone}.nav`);
    await inputs[1].uploadFile(`${mineDir}/${zone}.nav`);
    await new Promise(r => setTimeout(r, 1400));

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

    const canvas = await page.$("canvas");
    const box = await canvas.boundingBox();
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
