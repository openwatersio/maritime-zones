import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import { ahead, configure, distanceTo, distanceToLand, nearestTerritory, whereAmI } from "../src/index.ts";

// Needs dist/ from `npm run fetch && npm run build`; reads the built tiles directly, offline.
beforeAll(() => configure({ cacheDir: fileURLToPath(new URL("../dist/tiles/", import.meta.url)), download: false }));

const zones = async (lat: number, lon: number) => (await whereAmI(lat, lon)).map((z) => `${z.layer}:${z.iso_ter}`);

describe("ahead", () => {
  test("a Dutch coastal course crosses Belgium and France before its coastline contact", async () => {
    const result = await ahead(52.2, 4.2, 225, { maxNm: 120 });
    expect(result.start.map((z) => z.iso_ter)).toEqual(["NLD"]);
    expect(
      result.crossings.map((c) =>
        c.kind === "coast" ? "coast" : [c.leaving.map((z) => z.iso_ter), c.entering.map((z) => z.iso_ter)],
      ),
    ).toEqual([[["NLD"], ["BEL"]], [["BEL"], ["FRA"]], "coast"]);
    expect(result.crossings[0]!.distanceNm).toBeCloseTo(56.681, 2);
    expect(result.crossings[1]!.distanceNm).toBeCloseTo(89.58, 2);
    expect(result.crossings[2]!.distanceNm).toBeCloseTo(97.795, 2);
  });
  test("a North Sea course enters Belgium before the separate water-to-coast gap", async () => {
    const result = await ahead(51.8, 2.85, 180, { maxNm: 80 });
    expect(result.start).toEqual([]);
    const first = result.crossings[0]!;
    expect(first.kind === "water" && first.entering[0]!.iso_ter).toBe("BEL");
    expect(first.distanceNm).toBeCloseTo(21.111, 2);
    expect(result.crossings.map((c) => c.kind)).toEqual(["water", "water", "coast"]);
    expect(result.crossings[2]!.distanceNm - result.crossings[1]!.distanceNm).toBeGreaterThan(0.2);
  });
  test("Fiji coastline contact is found after crossing the antimeridian", async () => {
    const result = await ahead(-17.2, 179.8, 90, { maxNm: 120 });
    expect(result.start[0]!.iso_ter).toBe("FJI");
    expect(result.crossings).toHaveLength(1);
    expect(result.crossings[0]!.kind).toBe("coast");
    expect(result.crossings[0]!.point[1]).toBeLessThan(-179);
    expect(result.crossings[0]!.distanceNm).toBeCloseTo(68.223, 2);
  });
  test("the westbound Atlantic horizon contains no sovereign crossings", async () => {
    expect(await ahead(40, -40, 270)).toEqual({ start: [], onLand: false, crossings: [] });
  });
});

describe("whereAmI", () => {
  test("off Ostend is Belgian territorial sea inside the Belgian EEZ", async () => {
    expect(await zones(51.25, 2.85)).toEqual(["12nm:BEL", "eez:BEL"]);
  });

  test("the middle of the North Atlantic is high seas only", async () => {
    expect((await whereAmI(40, -40)).map((z) => z.layer)).toEqual(["high_seas"]);
  });

  test("Fiji's archipelagic waters on both sides of the antimeridian", async () => {
    expect(await zones(-18, 179.99)).toContain("archipelagic:FJI");
    expect(await zones(-18, -179.99)).toContain("archipelagic:FJI");
  });

  test("an island is a hole in every zone", async () => {
    // Rabi Island, Fiji, 16°30′S 179°59′W.
    expect(await whereAmI(-16.5, -179.99)).toEqual([]);
  });
});

describe("nearestTerritory", () => {
  test("Haro Strait: Canadian internal waters are about a mile away, not the outer coast", async () => {
    expect(await zones(48.6, -123.2)).toContain("12nm:USA");
    const hit = await nearestTerritory(48.6, -123.2);
    expect(hit?.zone?.iso_ter).toBe("CAN");
    expect(hit?.distanceNm).toBeLessThan(5);
  });

  test("mid North Atlantic: the Azores, whose Flores lies about 405 NM away, less 12 NM of sea", async () => {
    const hit = await nearestTerritory(40, -40);
    expect(hit?.zone?.iso_ter).toBe("PRT");
    expect(hit?.distanceNm).toBeGreaterThan(385);
    expect(hit?.distanceNm).toBeLessThan(400);
    expect(hit?.bearingDeg).toBeGreaterThan(80);
    expect(hit?.bearingDeg).toBeLessThan(100);
  });

  test("Labrador Sea: Greenland's 12 NM ring crosses the first search box but its nearest point is 345 NM away", async () => {
    // The first hit bounds the search; the answer must still be the nearest point of any ring, not the first ring found.
    const hit = await nearestTerritory(60.6, -62.7);
    expect(hit?.zone?.iso_ter).toBe("GRL");
    expect(hit?.distanceNm).toBeGreaterThan(335);
    expect(hit?.distanceNm).toBeLessThan(355);
    expect(hit?.bearingDeg).toBeGreaterThan(40);
    expect(hit?.bearingDeg).toBeLessThan(60);
  });
});

describe("distanceTo", () => {
  test("is zero inside the territory", async () => {
    expect((await distanceTo(51.25, 2.85, "BEL"))?.distanceNm).toBe(0);
  });

  test("Belgian waters from mid-Channel off Dover are across the French coast", async () => {
    const hit = await distanceTo(51.1, 1.4, "BEL");
    // Belgium's territorial sea starts at the French border near 2.54°E: ~43 NM east.
    expect(hit?.distanceNm).toBeGreaterThan(30);
    expect(hit?.distanceNm).toBeLessThan(50);
  });
});

describe("distanceToLand", () => {
  test("finds the nearest coast across the antimeridian", async () => {
    // East of 180 off Fiji; the nearest coast is Vanua Levu's, west of the line.
    const hit = await distanceToLand(-17.2, -179.95);
    expect(hit?.point[1]).toBeGreaterThan(179);
    expect(hit?.distanceNm).toBeLessThan(14);
  });

  test("mid North Atlantic is roughly as far from land as from Portuguese waters", async () => {
    const land = await distanceToLand(40, -40);
    const waters = await nearestTerritory(40, -40);
    expect(land!.distanceNm - waters!.distanceNm).toBeGreaterThan(8);
    expect(land!.distanceNm - waters!.distanceNm).toBeLessThan(16);
  });
});
