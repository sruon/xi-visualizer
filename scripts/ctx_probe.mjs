// node scripts/ctx_probe.mjs
//
// Counts WebGL contexts created and released while swapping zones. A viewer that disposes without
// forceContextLoss() leaves its context live, which no amount of heap profiling shows: the JS heap
// stays flat while the GPU holds every buffer. Browsers cap contexts around 16 and then start
// dropping the oldest, which is what "I have to restart my browser" looked like from the outside.
//
// Expect: live 0 (or 1, for whichever viewer is still on screen). Anything climbing with the swap
// count is the leak back.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const PORT = 5191;
const ZONES = ["131", "284", "1", "131", "284", "1"]; // small meshes: Mordion Gaol, Celennia, Phanauet
const BROWSERS = [
  process.env.BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
].filter(Boolean);

const browserPath = BROWSERS.find(p => existsSync(p));
if (!browserPath) {
  console.error("No browser found. Set BROWSER to a chrome or edge executable.");
  process.exit(1);
}

const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
process.on("exit", () => server.kill());
const settle = ms => new Promise(r => setTimeout(r, ms));
await settle(4000);

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();

// Wrap getContext before any app code runs; each context reports its own loss.
await page.evaluateOnNewDocument(() => {
  window.__ctx = { made: 0, lost: 0 };
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...rest) {
    const ctx = orig.call(this, type, ...rest);
    if (ctx && String(type).startsWith("webgl")) {
      window.__ctx.made++;
      this.addEventListener("webglcontextlost", () => window.__ctx.lost++);
    }
    return ctx;
  };
});

await page.goto(`http://localhost:${PORT}/xi-visualizer/#/zone/1`, { waitUntil: "networkidle2" });
await settle(12000);

// Without this the probe reports a clean 0/0 for a page that never drew anything, which reads as a pass.
if (await page.evaluate(() => window.__ctx.made) === 0) {
  console.error("FAIL: no WebGL context on the zone page. The probe is not measuring the viewer.");
  process.exit(1);
}

for (const zone of ZONES) {
  await page.evaluate(z => { window.location.hash = `#/zone/${z}`; }, zone);
  await settle(9000);
}

const { made, lost } = await page.evaluate(() => window.__ctx);
console.log(`zone swaps ${ZONES.length}: contexts created ${made}, released ${lost}, live ${made - lost}`);
await browser.close();
process.exit(made - lost > 1 ? 1 : 0);
