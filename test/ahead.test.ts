import { test } from "vitest";
import assert from "node:assert/strict";
import { createQueries } from "../src/queries.ts";
import type { Zone } from "../src/queries.ts";
import { expect } from "vitest";

type P = [number, number];
const rect = (x0: number, x1: number, y0 = -1, y1 = 1): P[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];
const zone = (iso: string, layer = "12nm", extra = {}) => ({ iso_ter: iso, layer, ...extra }) as Zone;
function fixture(zs: { zone: Zone; rings: P[][] }[], land: P[][] = []) {
  const features = zs
    .flatMap(({ rings }, i) => [
      {
        properties: { kind: "zone", zone: i },
        geometry: {
          xy: Float64Array.from(rings.flat(2)),
          ends: Uint32Array.from(rings.map((_, j) => rings.slice(0, j + 1).reduce((n, r) => n + r.length, 0))),
        },
      },
      ...rings.map((r) => ({
        properties: { kind: "boundary", zone: i },
        geometry: { xy: Float64Array.from(r.flat()), ends: null },
      })),
    ])
    .concat(
      land.map((r) => ({
        properties: { kind: "land", zone: -1 },
        geometry: { xy: Float64Array.from(r.flat()), ends: null },
      })),
    );
  return createQueries(
    async function* (_, box, kind) {
      for (const f of features) {
        if (kind === "line" ? !["boundary", "land"].includes(f.properties.kind) : f.properties.kind !== kind) continue;
        const xs = [...f.geometry.xy].filter((_, i) => i % 2 === 0),
          ys = [...f.geometry.xy].filter((_, i) => i % 2 === 1);
        if (
          Math.max(...xs) < box.minX ||
          Math.min(...xs) > box.maxX ||
          Math.max(...ys) < box.minY ||
          Math.min(...ys) > box.maxY
        )
          continue;
        yield f;
      }
    },
    () => new Proxy({}, { get: () => true }),
    () => zs.map((x) => x.zone),
  ).ahead;
}
const summary = (x: any) =>
  x.crossings.map((c: any) =>
    c.kind === "coast" ? "coast" : [c.leaving.map((z: Zone) => z.iso_ter), c.entering.map((z: Zone) => z.iso_ter)],
  );
test("shared border groups exit A and entry B", async () => {
  const result = await fixture([
    { zone: zone("A"), rings: [rect(0, 1)] },
    { zone: zone("B"), rings: [rect(1, 2)] },
  ])(0, 0.5, 90, { maxNm: 50 });
  assert.deepEqual(summary(result), [[["A"], ["B"]]]);
  assert.ok(Math.abs(result.crossings[0]!.distanceNm - 30.02023) < 0.001);
});
test("outside -> A -> outside", async () => {
  assert.deepEqual(summary(await fixture([{ zone: zone("A"), rings: [rect(1, 2)] }])(0, 0, 90, { maxNm: 150 })), [
    [[], ["A"]],
    [["A"], []],
  ]);
});
test("same territory layer transition suppressed", async () => {
  assert.deepEqual(
    summary(
      await fixture([
        { zone: zone("A", "internal"), rings: [rect(0, 1)] },
        { zone: zone("A"), rings: [rect(1, 3)] },
      ])(0, 0.5, 90, { maxNm: 120 }),
    ),
    [],
  );
});
test("overlap preserves A while entering B", async () => {
  assert.deepEqual(
    summary(
      await fixture([
        { zone: zone("A"), rings: [rect(0, 3)] },
        { zone: zone("B"), rings: [rect(1, 2)] },
      ])(0, 0.5, 90, { maxNm: 100 }),
    ),
    [
      [[], ["B"]],
      [["B"], []],
    ],
  );
});
test("joint regime parties participate in membership", async () => {
  const r = await fixture([
    { zone: zone("A"), rings: [rect(0, 1)] },
    { zone: zone("A", "12nm", { iso_ter2: "B" }), rings: [rect(1, 2)] },
  ])(0, 0.5, 90, { maxNm: 50 });
  assert.equal(r.crossings.length, 1);
  assert.equal(r.crossings[0]!.kind, "water");
  assert.deepEqual(summary(r), [[[], ["A"]]]);
});
test("vertex touch emits no water transition", async () => {
  assert.deepEqual(
    summary(
      await fixture([
        {
          zone: zone("A"),
          rings: [
            [
              [1, 0],
              [2, 1],
              [0, 1],
              [1, 0],
            ],
          ],
        },
      ])(0, 0, 90, { maxNm: 150 }),
    ),
    [],
  );
});
test("island stops at coastline rather than exiting sovereign water", async () => {
  const hole = rect(1, 2, -0.5, 0.5);
  assert.deepEqual(
    summary(await fixture([{ zone: zone("A"), rings: [rect(0, 4), hole] }], [hole])(0, 0.5, 90, { maxNm: 180 })),
    ["coast"],
  );
});
test("across antimeridian", async () => {
  const r = await fixture([{ zone: zone("FJI"), rings: [rect(-179.8, -179)] }])(0, 179.8, 90, { maxNm: 100 });
  assert.deepEqual(summary(r), [
    [[], ["FJI"]],
    [["FJI"], []],
  ]);
  assert.ok(Math.abs(r.crossings[0]!.distanceNm - 24.01618) < 0.001);
  assert.ok(Math.abs(r.crossings[0]!.point[1] + 179.8) < 1e-8);
});
test("empty horizon", async () => {
  assert.deepEqual(summary(await fixture([])(0, 0, 90, { maxNm: 480 })), []);
});
test("selected EEZ layer", async () => {
  const q = fixture([{ zone: zone("A", "eez"), rings: [rect(1, 2)] }]);
  assert.deepEqual(summary(await q(0, 0, 90, { maxNm: 80 })), []);
  assert.deepEqual(summary(await q(0, 0, 90, { maxNm: 80, layers: ["eez"] })), [[[], ["A"]]]);
});
test("high latitude eastbound rhumb distance", async () => {
  const r = await fixture([{ zone: zone("A"), rings: [rect(1, 2, 79, 81)] }])(80, 0, 90, { maxNm: 20 });
  assert.ok(
    Math.abs(r.crossings[0]!.distanceNm - ((3440.065 * Math.PI) / 180) * Math.cos((80 * Math.PI) / 180)) < 1e-6,
  );
});
test("diagonal rhumb uses Mercator intersection", async () => {
  const r = await fixture([{ zone: zone("A"), rings: [rect(1, 2, 0, 3)] }])(0, 0, 45, { maxNm: 120 });
  const phi = 2 * Math.atan(Math.exp(Math.PI / 180)) - Math.PI / 2;
  assert.ok(Math.abs(r.crossings[0]!.distanceNm - (phi * 3440.065) / Math.cos(Math.PI / 4)) < 1e-6);
});
test("start on shared boundary emits zero-distance transition", async () => {
  const r = await fixture([
    { zone: zone("A"), rings: [rect(0, 1)] },
    { zone: zone("B"), rings: [rect(1, 2)] },
  ])(0, 1, 90, { maxNm: 50 });
  assert.deepEqual(summary(r), [[["A"], ["B"]]]);
  assert.ok(r.crossings[0]!.distanceNm < 1e-6);
});
test("pole and invalid horizon rejected", async () => {
  await assert.rejects(fixture([])(89, 0, 0, { maxNm: 100 }), /pole/);
  await assert.rejects(fixture([])(0, 0, 0, { maxNm: 0 }), /maxNm/);
});
test("one straight geographic segment can cross the rhumb twice", async () => {
  const merc = (p: number) => Math.log(Math.tan(Math.PI / 4 + (p * Math.PI) / 360));
  const x = (lat: number) => ((merc(lat) - merc(80) - 0.01) * 180) / Math.PI;
  const ring: P[] = [
    [x(80.5), 80.5],
    [x(85), 85],
    [100, 82],
    [x(80.5), 80.5],
  ];
  const r = await fixture([{ zone: zone("A"), rings: [ring] }])(80, 0, 45, { maxNm: 480 });
  const onLongEdge = r.crossings.filter(
    (c) => Math.abs((c.point[0] - 80.5) / 4.5 - (c.point[1] - x(80.5)) / (x(85) - x(80.5))) < 1e-8,
  );
  assert.equal(onLongEdge.length, 2);
  assert.deepEqual(summary(r), [
    [[], ["A"]],
    [["A"], []],
    [[], ["A"]],
    [["A"], []],
  ]);
});
test("one metre grouping merges a tiny data gap", async () => {
  const q = fixture([
    { zone: zone("A"), rings: [rect(0, 1)] },
    { zone: zone("B"), rings: [rect(1 + 0.000005, 2)] },
  ]);

  assert.deepEqual(summary(await q(0, 0.5, 90, { maxNm: 50 })), [[["A"], ["B"]]]);
});
test("grouping works across thirty-mile scan steps", async () => {
  const border = (30 - 0.0001) / ((3440.065 * Math.PI) / 180);
  const q = fixture([
    { zone: zone("A"), rings: [rect(-1, border)] },
    { zone: zone("B"), rings: [rect(border + 0.000005, 2)] },
  ]);
  assert.deepEqual(summary(await q(0, 0, 90, { maxNm: 50 })), [[["A"], ["B"]]]);
});
test("the shared query factory exposes ahead", () => {
  expect(typeof fixture([])).toBe("function");
});
test("westbound antimeridian crossing uses the same along-course distance", async () => {
  const r = await fixture([{ zone: zone("A"), rings: [rect(179, 179.8)] }])(0, -179.8, 270, { maxNm: 50 });
  expect(summary(r)).toEqual([[[], ["A"]]]);
  expect(r.crossings[0]!.distanceNm).toBeCloseTo(24.01618, 4);
});
test("an eastbound polar course reports crossings on each revolution", async () => {
  const r = await fixture([{ zone: zone("A"), rings: [rect(10, 11, 89.8, 89.99)] }])(89.9, 0, 90);
  const nmPerDegree = ((3440.065 * Math.PI) / 180) * Math.cos((89.9 * Math.PI) / 180);
  const entries = r.crossings.filter((c) => c.kind === "water" && c.entering.length);
  expect(entries.length).toBe(Math.floor((480 - 10 * nmPerDegree) / (360 * nmPerDegree)) + 1);
  expect(entries[0]!.distanceNm).toBeCloseTo(10 * nmPerDegree, 6);
  expect(entries.at(-1)!.distanceNm).toBeCloseTo((10 + 360 * (entries.length - 1)) * nmPerDegree, 6);
});
test("a tiny horizon samples around the boundary without jumping another crossing", async () => {
  const scale = (3440.065 * Math.PI) / 180;
  const r = await fixture([{ zone: zone("A"), rings: [rect(0.0001 / scale, 0.0011 / scale)] }])(0, 0, 90, {
    maxNm: 0.0005,
  });
  expect(summary(r)).toEqual([[[], ["A"]]]);
  expect(r.crossings[0]!.distanceNm).toBeCloseTo(0.0001, 8);
});
test("coast contact keeps its own distance when grouped with a nearby water boundary", async () => {
  const q = fixture([{ zone: zone("A"), rings: [rect(0, 1)] }], [rect(1 + 0.000004, 2)]);
  const r = await q(0, 0.5, 90, { maxNm: 80 });
  expect(r.crossings).toHaveLength(1);
  expect(r.crossings[0]!.kind).toBe("coast");
  expect(r.crossings[0]!.point[1]).toBeCloseTo(1 + 0.000004, 8);
});
test("larger coastline gaps stay explicit", async () => {
  const r = await fixture([{ zone: zone("A"), rings: [rect(0, 1)] }], [rect(1.01, 2)])(0, 0.5, 90, { maxNm: 80 });
  expect(summary(r)).toEqual([[["A"], []], "coast"]);
});
test("selected zones without territory codes still report their transitions", async () => {
  const r = await fixture([{ zone: zone(null as any, "high_seas"), rings: [rect(1, 2)] }])(0, 0, 90, {
    maxNm: 80,
    layers: ["high_seas"],
  });
  expect(r.crossings).toHaveLength(1);
  const c = r.crossings[0]!;
  expect(c.kind === "water" && c.entering[0]!.layer).toBe("high_seas");
});
test("invalid positions, courses, horizons and layers fail before reading tiles", async () => {
  const q = fixture([]);
  for (const [lat, lon, cog, maxNm] of [
    [90, 0, 0, 1],
    [-90, 0, 0, 1],
    [0, 181, 0, 1],
    [NaN, 0, 0, 1],
    [0, 0, Infinity, 1],
    [0, 0, 0, -1],
    [0, 0, 0, 481],
    [0, 0, 0, NaN],
  ])
    await expect(q(lat!, lon!, cog!, { maxNm })).rejects.toBeInstanceOf(RangeError);
  await expect(q(0, 0, 0, { layers: ["TS" as any] })).rejects.toBeInstanceOf(RangeError);
});
test("a course expressed in additional revolutions has the same crossings", async () => {
  const q = fixture([{ zone: zone("A"), rings: [rect(1, 2)] }]);
  expect(await q(0, 0, 450, { maxNm: 80 })).toEqual(await q(0, 0, 90, { maxNm: 80 }));
});
test("near-east and west courses recover distance on a stable axis", async () => {
  const distance = ((3440.065 * Math.PI) / 180) * Math.cos((50 * Math.PI) / 180);
  for (const direction of [90, 270]) {
    const longitude = direction === 90 ? 1 : -1;
    const q = fixture(
      [],
      [
        [
          [longitude, 49],
          [longitude, 51],
        ],
      ],
    );
    for (const delta of [-1e-10, -1e-11, 0, 1e-11, 1e-10]) {
      const r = await q(50, 0, direction + delta, { maxNm: 80 });
      expect(r.crossings).toHaveLength(1);
      expect(r.crossings[0]!.distanceNm).toBeCloseTo(distance, 6);
      expect(r.crossings[0]!.point[1]).toBeCloseTo(longitude, 8);
    }
  }
});
test("origin contacts remain zero for every horizon", async () => {
  const q = fixture([
    { zone: zone("A"), rings: [rect(0, 1)] },
    { zone: zone("B"), rings: [rect(1, 2)] },
  ]);
  for (const maxNm of [0.0005, 0.1, 1, 2, 10, 20, 30, 50]) {
    const r = await q(0, 1, 90, { maxNm });
    expect(summary(r)).toEqual([[["A"], ["B"]]]);
    expect(r.crossings[0]!.distanceNm).toBe(0);
  }
});
test("origin classification stays inside the immediately preceding narrow territory", async () => {
  const q = fixture([
    { zone: zone("C"), rings: [rect(0, 1 - 0.000045)] },
    { zone: zone("A"), rings: [rect(1 - 0.000045, 1)] },
    { zone: zone("B"), rings: [rect(1, 2)] },
  ]);
  expect(summary(await q(0, 1, 90, { maxNm: 50 }))).toEqual([[["A"], ["B"]]]);
});
test("backward classification of a southbound origin contact stays below the pole", async () => {
  const q = fixture([
    { zone: zone("A"), rings: [rect(-1, 1, 88, 89.99999)] },
    { zone: zone("B"), rings: [rect(-1, 1, 89.99999, 90)] },
  ]);
  const r = await q(89.99999, 0, 180, { maxNm: 1 });
  expect(summary(r)).toEqual([[["B"], ["A"]]]);
  expect(r.crossings[0]!.distanceNm).toBe(0);
});
test("numerical horizon contacts are included without extending their distance", async () => {
  for (const longitude of [0.2, 0.4, 1.1, 1.5, 3, 4, 5]) {
    const maxNm = ((3440.065 * Math.PI) / 180) * longitude;
    const r = await fixture(
      [],
      [
        [
          [longitude, -1],
          [longitude, 1],
        ],
      ],
    )(0, 0, 90, { maxNm });
    expect(r.crossings).toHaveLength(1);
    expect(r.crossings[0]!.distanceNm).toBe(maxNm);
    expect(r.crossings[0]!.point[1]).toBeCloseTo(longitude, 8);
  }
});
test("extreme polar horizons fail promptly instead of scanning unbounded revolutions", async () => {
  await expect(fixture([])(89.99999999, 0, 90)).rejects.toThrow(/revolutions/);
});
