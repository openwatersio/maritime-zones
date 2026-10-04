import { serialize } from "flatgeobuf/lib/mjs/geojson.js";
import { fromFeature as eagerFeature } from "flatgeobuf/lib/mjs/geojson/feature.js";
import { deserialize } from "flatgeobuf/lib/mjs/generic.js";
import { expect, test, vi } from "vitest";
import { fromFeature } from "../src/feature.ts";
import { createQueries, type Zone } from "../src/queries.ts";

test("course scans share a boundary and land read without allocating zone coordinates", async () => {
  const bytes = serialize({
    type: "FeatureCollection",
    features: ["zone", "boundary", "land"].map((kind) => ({
      type: "Feature" as const,
      properties: { kind, zone: 0 },
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [1, 1],
          [2, 1],
        ],
      },
    })),
  });
  const kinds: string[] = [];
  for await (const _ of deserialize(bytes, {
    fromFeature(id, raw, header) {
      const properties = eagerFeature(id, raw, header).properties!;
      const geometry = vi.spyOn(raw, "geometry");
      const result = fromFeature(id, raw, header, "line");
      if (properties.kind === "zone") {
        expect(result).toBeUndefined();
        expect(geometry).not.toHaveBeenCalled();
      } else {
        expect(result!.geometry.xy.buffer).toBe(bytes.buffer);
        kinds.push(result!.properties.kind);
      }
      return result ?? {};
    },
  })) {
  }
  expect(kinds.sort()).toEqual(["boundary", "land"]);
});

test("land queries decode only land geometry and preserve the GeoJSON result", async () => {
  const bytes = serialize({
    type: "FeatureCollection",
    features: ["boundary", "land"].map((kind) => ({
      type: "Feature" as const,
      properties: { kind, zone: -1 },
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [1, 1],
          [2, 1],
        ],
      },
    })),
  });
  const queries = createQueries(
    async function* (_tile, _rect, kind) {
      expect(kind).toBe("land");
      for await (const feature of deserialize(bytes, {
        fromFeature(id, raw, header) {
          const expected = eagerFeature(id, raw, header);
          const read = vi.spyOn(raw, "geometry");
          const decoded = fromFeature(id, raw, header, kind);
          if (expected.properties!.kind === kind) {
            expect(decoded!.geometry).toMatchObject({ xy: new Float64Array([1, 1, 2, 1]), ends: null });
            expect(decoded!.geometry.xy.buffer).toBe(bytes.buffer);
            expect(read).toHaveBeenCalledTimes(1);
          } else {
            expect(decoded).toBeUndefined();
            expect(read).not.toHaveBeenCalled();
          }
          expect(fromFeature(id, raw, header)).toEqual(expected);
          return decoded ?? {};
        },
      }))
        if ("geometry" in feature) yield feature;
    },
    () => ({ n0e0: {} }),
    () => [],
  );
  const hit = await queries.distanceToLand(1.01, 1.5);
  expect(hit?.distanceNm).toBeCloseTo(0.6004, 2);
});

test("zone queries read ring ends without filling polygon holes", async () => {
  const bytes = serialize({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { kind: "zone", zone: 0 },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [4, 0],
              [4, 4],
              [0, 4],
              [0, 0],
            ],
            [
              [1, 1],
              [3, 1],
              [3, 3],
              [1, 3],
              [1, 1],
            ],
          ],
        },
      },
    ],
  });
  const zone = { layer: "12nm", iso_ter: "BEL" } as Zone;
  const queries = createQueries(
    async function* (_tile, _rect, kind) {
      for await (const f of deserialize(bytes, {
        fromFeature(id, raw, header) {
          const decoded = fromFeature(id, raw, header, kind)!;
          expect(decoded.geometry.xy.buffer).toBe(bytes.buffer);
          expect(decoded.geometry.ends).toEqual(new Uint32Array([5, 10]));
          return decoded;
        },
      }))
        yield f;
    },
    () => ({ n0e0: {} }),
    () => [zone],
  );
  expect(await queries.whereAmI(0.5, 0.5)).toEqual([zone]);
  expect(await queries.whereAmI(2, 2)).toEqual([]);
  expect(await queries.whereAmI(5, 5)).toEqual([]);
});
