import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { deserialize } from "flatgeobuf/lib/mjs/geojson.js";
import { expect, test } from "vitest";

test("builds World Countries rings into seekable land tiles, outside the zone table", async () => {
  const work = mkdtempSync(join(tmpdir(), "maritime-zones-build-"));
  try {
    for (const file of [
      "scripts/build.ts",
      "scripts/layers.ts",
      "src/tiles.ts",
      "src/index.ts",
      "src/ahead.ts",
      "src/feature.ts",
      "src/queries.ts",
      "src/store.ts",
    ]) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      copyFileSync(new URL(`../${file}`, import.meta.url), join(work, file));
    }
    writeFileSync(join(work, "package.json"), '{"type":"module","version":"0.1.1","tileVersion":"0.1.0"}');
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(work, "node_modules"));
    for (const key of ["internal", "archipelagic", "12nm", "24nm", "eez", "high_seas", "land", "countries"]) {
      mkdirSync(join(work, "tmp", key), { recursive: true });
    }
    writeFileSync(
      join(work, "tmp", "land", "old.json"),
      JSON.stringify({
        features: [
          {
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [31, 31],
                  [32, 31],
                  [32, 32],
                  [31, 31],
                ],
              ],
            },
          },
        ],
      }),
    );
    writeFileSync(
      join(work, "tmp", "countries", "country.json"),
      JSON.stringify({
        features: [
          {
            properties: { territory1: "Fixture country" },
            geometry: {
              type: "MultiPolygon",
              coordinates: [
                [
                  [
                    [1, 1],
                    [2, 1],
                    [2, 2],
                    [1, 2],
                    [1, 1],
                  ],
                  [
                    [1.2, 1.2],
                    [1.4, 1.2],
                    [1.4, 1.4],
                    [1.2, 1.4],
                    [1.2, 1.2],
                  ],
                ],
                [
                  [
                    [3, 3],
                    [4, 3],
                    [4, 4],
                    [3, 4],
                    [3, 3],
                  ],
                ],
              ],
            },
          },
        ],
      }),
    );
    writeFileSync(
      join(work, "tmp", "coastlines.geojsonl"),
      JSON.stringify({
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [31, 31],
            [32, 31],
          ],
        },
      }) + "\n",
    );
    execFileSync(process.execPath, [join(work, "scripts/build.ts")]);
    const index = JSON.parse(readFileSync(join(work, "dist/tiles.json"), "utf8"));
    expect(Object.keys(index.tiles)).toEqual(["n0e0"]);
    expect(JSON.parse(readFileSync(join(work, "dist/zones.json"), "utf8"))).toEqual([]);
    execFileSync("ogr2ogr", [
      "-f",
      "FlatGeobuf",
      "-where",
      "kind = 'boundary' AND zone IN (0)",
      join(work, "boundaries.fgb"),
      join(work, "dist/tiles/n0e0.fgb"),
    ]);
    const bytes = readFileSync(join(work, "dist/tiles/n0e0.fgb.zst"));
    expect(index.tiles.n0e0).toEqual({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    const raw = zstdDecompressSync(bytes);
    expect(raw).toEqual(readFileSync(join(work, "dist/tiles/n0e0.fgb")));
    const features = [];
    for await (const feature of deserialize(new Uint8Array(raw))) features.push(feature);
    expect(features).toHaveLength(3);
    expect(features.every((f) => f.properties?.kind === "land" && f.properties?.zone === -1)).toBe(true);
    expect(features.map((f) => (f.geometry?.type === "LineString" ? f.geometry.coordinates : null))).toEqual(
      expect.arrayContaining([
        [
          [1, 1],
          [2, 1],
          [2, 2],
          [1, 2],
          [1, 1],
        ],
        [
          [1.2, 1.2],
          [1.4, 1.2],
          [1.4, 1.4],
          [1.2, 1.4],
          [1.2, 1.2],
        ],
        [
          [3, 3],
          [4, 3],
          [4, 4],
          [3, 4],
          [3, 3],
        ],
      ]),
    );
    const { configure, distanceToLand } = await import(pathToFileURL(join(work, "src/index.ts")).href);
    configure({ cacheDir: join(work, "dist/tiles"), download: false });
    const hit = await distanceToLand(1.01, 1.5);
    expect(hit?.zone).toBeNull();
    expect(hit?.distanceNm).toBeCloseTo(0.6004, 2);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
