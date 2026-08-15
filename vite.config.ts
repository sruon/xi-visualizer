import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import solidPlugin from "vite-plugin-solid";

// Dev only: serve zone folders straight off disk, and write them back, so the Regions page can be
// pointed at freshly generated bootstrap output without pushing it anywhere first. Override the
// directory with XI_ZONES_DIR. The deployed build has none of this and reads GitHub instead.
const ZONES_DIR = process.env.XI_ZONES_DIR
  ?? "C:/Users/sruon/Documents/GitHub/xi-regions-bootstrap/py/out/data/zones";

function localZones(): Plugin {
  return {
    name: "local-zones",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/local-zones", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
        if (rel.includes("..")) {
          res.statusCode = 400;
          return res.end("no traversal");
        }

        if (rel === "/") {
          res.setHeader("content-type", "application/json");
          try {
            const names = fs.readdirSync(ZONES_DIR, { withFileTypes: true })
              .filter(e => e.isDirectory() && fs.existsSync(path.join(ZONES_DIR, e.name, "mobs.yaml")))
              .map(e => e.name)
              .sort();
            return res.end(JSON.stringify(names));
          } catch {
            res.statusCode = 404; // no such directory: the page falls back to GitHub
            return res.end("[]");
          }
        }

        const file = path.join(ZONES_DIR, rel);
        if (req.method === "PUT") {
          let body = "";
          req.on("data", chunk => (body += chunk));
          req.on("end", () => {
            try {
              fs.writeFileSync(file, body);
              res.end("saved");
            } catch (e) {
              res.statusCode = 500;
              res.end(String(e));
            }
          });
          return;
        }

        try {
          res.setHeader("content-type", "text/plain; charset=utf-8");
          return res.end(fs.readFileSync(file));
        } catch {
          res.statusCode = 404;
          return res.end("not found");
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [solidPlugin(), localZones()],
  server: {
    port: 3000,
  },
  build: {
    target: "esnext",
  },
  base: "/xi-visualizer",
  optimizeDeps: {
    exclude: ["solid-icons"], // To prevent "React is undefined" error
  },
});
