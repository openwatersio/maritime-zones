import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./layers.ts";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";

const out = join(ROOT, "public");
const version =
  process.env.TILE_VERSION || `v${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).tileVersion}`;
if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error(`Invalid tile version: ${version}`);
mkdirSync(out, { recursive: true });
copyFileSync(join(ROOT, "demo/index.html"), join(out, "index.html"));
copyFileSync(join(ROOT, "node_modules/@bokuweb/zstd-wasm/dist/web/zstd.wasm"), join(out, "zstd.wasm"));
for (const entry of ["reader", "regulations", "main"]) {
  await build({
    entryPoints: [join(ROOT, `demo/${entry}.ts`)],
    outfile: join(out, `${entry}.js`),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    sourcemap: true,
    external: ["./reader.js", "./regulations.js"],
    loader: { ".png": "file" },
    define: { TILE_VERSION: JSON.stringify(version) },
  });
}
console.log(`Built demos for ${version} in ${out}`);

if (process.argv.includes("--serve")) {
  // The seekable reader needs suffix ranges, which Vite's static server does not support.
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".png": "image/png",
  };
  createServer((req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url!, "http://localhost").pathname);
      const file = resolve(out, `.${path === "/" ? "/index.html" : path}`);
      if (!file.startsWith(out + "/")) {
        res.writeHead(403).end();
        return;
      }
      const bytes = readFileSync(file);
      res.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
      res.setHeader("Accept-Ranges", "bytes");
      let start = 0,
        end = bytes.length - 1;
      if (req.headers.range) {
        const range = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
        if (!range || (!range[1] && !range[2])) {
          res.writeHead(416).end();
          return;
        }
        start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
        end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
        if (start > end || !Number.isSafeInteger(start)) {
          res.writeHead(416).end();
          return;
        }
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
      }
      res.setHeader("Content-Length", end - start + 1);
      res.end(req.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
    } catch {
      res.writeHead(404).end();
    }
  }).listen(4173, "127.0.0.1", () => console.log("Preview: http://127.0.0.1:4173/"));
}
