import { serialize } from "flatgeobuf/lib/mjs/geojson.js";
import { fromFeature as eagerFeature } from "flatgeobuf/lib/mjs/geojson/feature.js";
import { deserialize } from "flatgeobuf/lib/mjs/generic.js";
import { expect, test, vi } from "vitest";
import { fromFeature } from "../src/feature.ts";
import { createQueries } from "../src/queries.ts";

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
            expect(decoded).toEqual(expected);
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
