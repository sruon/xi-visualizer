import puppeteer from "puppeteer-core";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT = process.argv[2], A = process.argv[3].replace(/\\/g, "/"), B = process.argv[4].replace(/\\/g, "/");
const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1200,820"] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 820 });
page.on("pageerror", e => console.log("[pageerror]", e.message));
await page.goto("http://localhost:3000/xi-visualizer/", { waitUntil: "networkidle0" });
await page.evaluate(() => [...document.querySelectorAll("a")].find(a => a.textContent.trim() === "Navmesh Diff")?.click());
await new Promise(r => setTimeout(r, 800));
const inputs = await page.$$('input[type="file"]');
await inputs[0].uploadFile(A);
await inputs[1].uploadFile(B);
await new Promise(r => setTimeout(r, 2500));
const panel = await page.evaluate(() => document.querySelector(".w-64")?.innerText || "(no panel)");
console.log("PANEL:\n" + panel);
const canvas = await page.$("canvas");
if (canvas) {
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2 - 80, { steps: 8 });
  await page.mouse.up();
  await new Promise(r => setTimeout(r, 400));
}
await page.screenshot({ path: OUT });
console.log("shot ->", OUT);
await browser.close();
