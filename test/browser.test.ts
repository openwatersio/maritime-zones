import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpReader } from "flatgeobuf/lib/mjs/http-reader.js";
import { SeekableZstdReader } from "flatgeobuf/lib/mjs/seekable-zstd.js";
import { fromFeature } from "../src/feature.ts";
import { expect, it, vi } from "vitest";
import { serveRanges } from "../benchmarks/range-server.ts";
import { createQueries, type Zone } from "../src/queries.ts";
import { DIST } from "../scripts/layers.ts";

it("answers all four questions from HTTP ranges of the published tile format", async () => {
  const index = JSON.parse(readFileSync(join(DIST, "tiles.json"), "utf8")).tiles;
  const zones: Zone[] = JSON.parse(readFileSync(join(DIST, "zones.json"), "utf8"));
  const server = await serveRanges(join(DIST, "tiles"));
  const reader = createQueries(
    async function* (tile, rect, kind) {
      const source = await SeekableZstdReader.open(`${server.url}${tile}.fgb.zst`);
      const reader = await HttpReader.openSource(source);
      for await (const { id, feature } of reader.selectBbox(rect)) {
        const decoded = fromFeature(id, feature, reader.header, kind);
        if (decoded) yield decoded;
      }
    },
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
    expect(server.requests).toBeGreaterThan(0);
  } finally {
    await server.close();
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
    const { whereAmI, distanceToLand } = await import("../demo/reader.ts");
    await expect(whereAmI(51.25, 2.85)).rejects.toThrow("Could not load zstd.wasm: HTTP 503");
    expect((await whereAmI(51.25, 2.85)).map((z) => `${z.layer}:${z.iso_ter}`)).toEqual(["12nm:BEL", "eez:BEL"]);
    expect(wasmRequests).toBe(2);
    const land = await distanceToLand(66.2, 8.4);
    expect(land?.distanceNm).toBeCloseTo(79.25426694593823, 6);
    expect(land?.zone).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
