import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { configure, download, tilesFor, whereAmI } from "../src/index.ts";

// Serves dist/tiles the way a GitHub release serves its assets, flat, plus one
// corrupted tile. Needs dist/ from `npm run fetch && npm run build`.
const tiles = new URL("../dist/tiles/", import.meta.url);
let server: Server;
let baseUrl: string;
const requests: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const name = req.url!.slice(1);
    requests.push(name);
    if (name === "truncated/n50e0.fgb.zst") {
      const bytes = readFileSync(new URL("n50e0.fgb.zst", tiles));
      res.writeHead(200, { "Content-Length": bytes.length });
      res.flushHeaders();
      res.write(bytes.subarray(0, bytes.length >> 1));
      // Drop the connection after the headers and part of the body are out.
      setTimeout(() => res.destroy(), 50);
      return;
    }
    if (name === "corrupt/n50e0.fgb.zst") {
      const bytes = readFileSync(new URL("n50e0.fgb.zst", tiles));
      bytes[bytes.length - 1]! ^= 0xff;
      return res.end(bytes);
    }
    try {
      res.end(readFileSync(new URL(name, tiles)));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => server.close());

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "maritime-zones-cache-"));
  requests.length = 0;
});

describe("tilesFor", () => {
  test("the Salish Sea fits in one tile", () => {
    expect(tilesFor({ minLat: 47, minLon: -125, maxLat: 49.5, maxLon: -122 }).map((t) => t.tile)).toEqual(["n40w130"]);
  });

  test("a circle across the antimeridian needs tiles on both sides", () => {
    const names = tilesFor({ lat: -17, lon: 179.5, radiusNm: 60 }).map((t) => t.tile);
    expect(names).toContain("s20e170");
    expect(names).toContain("s20w180");
  });

  test("reports each tile's download size", () => {
    const [salish] = tilesFor({ lat: 48.6, lon: -123.2, radiusNm: 5 });
    expect(salish!.bytes).toBe(readFileSync(new URL("n40w130.fgb.zst", tiles)).length);
  });
});

describe("downloads", () => {
  test("a query downloads the tile it needs into the cache, then answers", async () => {
    configure({ cacheDir, baseUrl });
    expect((await whereAmI(51.25, 2.85)).map((z) => `${z.layer}:${z.iso_ter}`)).toEqual(["12nm:BEL", "eez:BEL"]);
    expect(requests).toEqual(["n50e0.fgb.zst"]);
    expect(readdirSync(cacheDir)).toEqual(["n50e0.fgb.zst"]);
    expect(readFileSync(join(cacheDir, "n50e0.fgb.zst")).equals(readFileSync(new URL("n50e0.fgb.zst", tiles)))).toBe(
      true,
    );
  });

  test("a cached tile is not downloaded again", async () => {
    configure({ cacheDir, baseUrl });
    await download({ lat: 51.25, lon: 2.85, radiusNm: 1 });
    configure({ cacheDir, baseUrl, download: false }); // a fresh process: nothing in memory
    expect((await whereAmI(51.25, 2.85)).map((z) => `${z.layer}:${z.iso_ter}`)).toEqual(["12nm:BEL", "eez:BEL"]);
    expect(requests).toEqual(["n50e0.fgb.zst"]);
  });

  test("a damaged compressed cache is treated as missing and can be downloaded again", async () => {
    configure({ cacheDir, baseUrl });
    await download({ lat: 51.25, lon: 2.85, radiusNm: 1 });
    const file = join(cacheDir, "n50e0.fgb.zst");
    const bytes = readFileSync(file);
    bytes[bytes.length - 1]! ^= 0xff;
    writeFileSync(file, bytes);
    configure({ cacheDir, baseUrl, download: false });
    await expect(whereAmI(51.25, 2.85)).rejects.toMatchObject({ code: "MISSING_TILE", tile: "n50e0" });
    configure({ cacheDir, baseUrl });
    expect((await whereAmI(51.25, 2.85)).map((z) => `${z.layer}:${z.iso_ter}`)).toEqual(["12nm:BEL", "eez:BEL"]);
    expect(requests).toEqual(["n50e0.fgb.zst", "n50e0.fgb.zst"]);
  });

  test("download() fetches every tile for an area and reports the total", async () => {
    configure({ cacheDir, baseUrl });
    const area = { lat: -17, lon: 179.5, radiusNm: 60 };
    const result = await download(area);
    expect(result.tiles).toBe(tilesFor(area).length);
    expect(readdirSync(cacheDir).sort()).toEqual(
      tilesFor(area)
        .map((t) => `${t.tile}.fgb.zst`)
        .sort(),
    );
  });

  test("a tile that does not match its sha256 is rejected and not cached", async () => {
    configure({ cacheDir, baseUrl: `${baseUrl}/corrupt` });
    await expect(whereAmI(51.25, 2.85)).rejects.toMatchObject({ code: "CHECKSUM", tile: "n50e0" });
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  test("a failed download says which tile and why", async () => {
    configure({ cacheDir, baseUrl: `${baseUrl}/missing` });
    await expect(whereAmI(51.25, 2.85)).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", tile: "n50e0" });
  });

  test("a connection that drops mid-download is a failed download, not a raw error", async () => {
    configure({ cacheDir, baseUrl: `${baseUrl}/truncated` });
    await expect(whereAmI(51.25, 2.85)).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", tile: "n50e0" });
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  test("with downloads off, a missing tile throws instead of answering short", async () => {
    configure({ cacheDir, baseUrl, download: false });
    await expect(whereAmI(51.25, 2.85)).rejects.toMatchObject({ code: "MISSING_TILE", tile: "n50e0" });
    expect(requests).toEqual([]);
  });
});
