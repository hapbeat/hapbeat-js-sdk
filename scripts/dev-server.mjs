/**
 * Zero-dependency dev server with hot reload for trying the examples locally.
 *
 *   npm run dev            # build dist/, watch src/ (tsc --watch), serve + live-reload
 *   npm run serve          # static serve only (no watch / no reload)
 *   PORT=8080 npm run dev
 *
 * Hot reload, no external deps:
 *  - spawns `tsc --watch` so editing src/*.ts rebuilds dist/ automatically
 *  - watches dist/ + examples/ and pushes a reload over Server-Sent Events
 *  - injects a tiny EventSource snippet into served HTML
 *
 * Serves the whole repo so /dist/browser.js and /examples/games/ are both
 * reachable. Not part of the published npm package (scripts/ is outside "files").
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { watch, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// 8170: avoids Vite (5173, used by hapbeat-studio), Astro (4321), serve (3000)
// and the helper ports (7700/7701/7703). Override with PORT=... npm run dev.
const PORT = process.env.PORT ? Number(process.env.PORT) : 8170;
const ENTRY = "/examples/games/";
const WATCH = !process.argv.includes("--no-watch");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const LIVERELOAD = `\n<script>(function(){try{var es=new EventSource('/__livereload');var t;es.onmessage=function(){clearTimeout(t);t=setTimeout(function(){location.reload();},120);};}catch(e){}})();</script>\n`;

// ── live-reload plumbing ─────────────────────────────────────
const clients = new Set();
let debounce;
function notifyReload(label) {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    if (clients.size) console.log(`  ↻ reload (${label})`);
    for (const res of clients) res.write("data: reload\n\n");
  }, 120);
}

// ── http server ──────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);

  if (urlPath === "/__livereload") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(":ok\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (urlPath === "/") {
    res.writeHead(302, { Location: ENTRY });
    return res.end();
  }

  // resolve safely under ROOT (block path traversal)
  const rel = normalize(urlPath).replace(/^([/\\])+/, "");
  let path = join(ROOT, rel);
  if (!path.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("403");
  }
  try {
    const s = await stat(path);
    if (s.isDirectory()) path = join(path, "index.html");
    const ext = extname(path);
    if (ext === ".html" && WATCH) {
      let html = await readFile(path, "utf8");
      html = html.includes("</body>") ? html.replace("</body>", LIVERELOAD + "</body>") : html + LIVERELOAD;
      res.writeHead(200, { "Content-Type": TYPES[".html"] });
      return res.end(html);
    }
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`404 Not Found: ${urlPath}`);
  }
});

// ── watchers + tsc --watch ───────────────────────────────────
let tsc;
if (WATCH) {
  for (const dir of ["examples", "dist"]) {
    const abs = join(ROOT, dir);
    if (existsSync(abs)) {
      try {
        watch(abs, { recursive: true }, (_e, file) => notifyReload(`${dir}/${file ?? ""}`));
      } catch (e) {
        console.warn(`  (watch ${dir} unavailable: ${e.message})`);
      }
    }
  }
  // rebuild SDK on src/*.ts changes
  const tscBin = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  if (existsSync(tscBin)) {
    tsc = spawn(process.execPath, [tscBin, "--watch", "--preserveWatchOutput"], { cwd: ROOT });
    const tag = (d) => String(d).split("\n").filter(Boolean).map((l) => `  [tsc] ${l}`).join("\n");
    tsc.stdout.on("data", (d) => console.log(tag(d)));
    tsc.stderr.on("data", (d) => console.error(tag(d)));
  } else {
    console.warn("  (typescript not found — run `npm install`; serving without auto-rebuild)");
  }
}

function shutdown() {
  if (tsc) tsc.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, () => {
  console.log(`\n  Hapbeat Arcade dev server${WATCH ? " (hot reload)" : ""}`);
  console.log(`  → http://localhost:${PORT}${ENTRY}\n`);
  console.log(`  Ctrl+C to stop\n`);
});
