import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { deserialize } from "flatgeobuf/lib/mjs/geojson.js";
import { expect, it, vi } from "vitest";
import { createQueries, type Zone } from "../src/queries.ts";
import { DIST } from "../scripts/layers.ts";

it("answers all four questions from HTTP ranges of the published tile format", async () => {
  const index = JSON.parse(readFileSync(join(DIST, "tiles.json"), "utf8")).tiles;
  const zones: Zone[] = JSON.parse(readFileSync(join(DIST, "zones.json"), "utf8"));
  let ranges = 0;
  const server = createServer((req, res) => {
    if (!/^\/[ns]\d+[ew]\d+\.fgb\.zst$/.test(req.url!)) {
      res.writeHead(404).end();
      return;
    }
    const file = readFileSync(join(DIST, "tiles", req.url!.slice(1)));
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (!range) {
      res.writeHead(400).end();
      return;
    }
    const start = range[1] ? Number(range[1]) : file.length - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), file.length - 1) : file.length - 1;
    const bytes = file.subarray(start, end + 1);
    ranges++;
    res.writeHead(206, { "Content-Length": bytes.length, "Content-Range": `bytes ${start}-${end}/${file.length}` });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server port");
  const reader = createQueries(
    (tile, rect) => deserialize(`http://127.0.0.1:${address.port}/${tile}.fgb.zst`, { rect, seekableZstd: true }),
    () => index,
    () => zones,
  );
  try {
    expect((await reader.whereAmI(51.25, 2.85)).map((z) => `${z.layer}:${z.iso_ter}`)).toEqual(["12nm:BEL", "eez:BEL"]);
    const next = await reader.nearestTerritory(48.6, -123.2);
    expect(next?.zone?.iso_ter).toBe("CAN");
    expect(next?.zone?.layer).toBe("internal");
    expect(next?.distanceNm).toBeCloseTo(1.4, 0);
    expect((await reader.distanceTo(51.1, 1.4, "BEL"))?.distanceNm).toBeCloseTo(38.6, 0);
    expect((await reader.distanceToLand(40, -40))?.distanceNm).toBeGreaterThan(400);
    expect((await reader.whereAmI(-17.9, -179.9)).some((z) => z.layer === "archipelagic")).toBe(true);
    expect(ranges).toBeGreaterThan(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30000);

it("retries a failed WASM download before initializing the browser codec", async () => {
  vi.stubGlobal("TILE_VERSION", "v0.1.0");
  let wasmRequests = 0;
  vi.stubGlobal("fetch", async (url: string | URL, options?: RequestInit) => {
    const name = new URL(url).pathname.split("/").at(-1)!;
    if (name === "zstd.wasm") {
      if (++wasmRequests === 1) return new Response("Unavailable", { status: 503 });
      return new Response(readFileSync("node_modules/@bokuweb/zstd-wasm/dist/web/zstd.wasm"));
    }
    if (name.endsWith(".json")) return new Response(readFileSync(join(DIST, name)));
    const bytes = readFileSync(join(DIST, "tiles", name));
    const range = new Headers(options?.headers).get("Range")!.match(/^bytes=(\d*)-(\d*)$/)!;
    const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}` },
    });
  });
  try {
    const { whereAmI } = await import("../demo/reader.ts");
    await expect(whereAmI(51.25, 2.85)).rejects.toThrow("Could not load zstd.wasm: HTTP 503");
    expect((await whereAmI(51.25, 2.85)).map((z) => `${z.layer}:${z.iso_ter}`)).toEqual(["12nm:BEL", "eez:BEL"]);
    expect(wasmRequests).toBe(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
