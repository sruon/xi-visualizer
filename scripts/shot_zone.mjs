import puppeteer from "puppeteer-core";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT = process.argv[2], NAV = process.argv[3].replace(/\\/g, "/"), TILT = process.argv[4] === "tilt";
const b = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--window-size=1200,820"] });
const p = await b.newPage();
await p.setViewport({ width: 1200, height: 820 });
p.on("pageerror", e => console.log("[pageerror]", e.message));
await p.goto("http://localhost:3000/xi-visualizer/", { waitUntil: "networkidle0" });
await p.evaluate(() => [...document.querySelectorAll("a")].find(a => a.textContent.trim() === "Navmesh")?.click());
await new Promise(r => setTimeout(r, 600));
await (await p.$('input[type="file"]')).uploadFile(NAV);
await new Promise(r => setTimeout(r, 1600));
const stats = await p.evaluate(() => document.querySelector(".w-56")?.innerText.split("\n").slice(0, 6).join(" | ") || "");
console.log("PANEL:", stats);
if (TILT) {
  const cv = await p.$("canvas"); const box = await cv.boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 - 150, { steps: 12 });
  await p.mouse.up();
  await new Promise(r => setTimeout(r, 400));
}
await p.screenshot({ path: OUT });
console.log("shot ->", OUT);
await b.close();
