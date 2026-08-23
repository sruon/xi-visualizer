import { readFileSync, writeFileSync, readdirSync } from "node:fs";

// Build an HTML contact sheet from the batch-diff output (diffs/*.png + manifest.json).
// Usage: node _gen_gallery.mjs <diffsDir>
const dir = process.argv[2];
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
