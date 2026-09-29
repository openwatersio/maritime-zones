import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { configure, distanceTo, distanceToLand, nearestTerritory, whereAmI } from "../src/index.ts";

// Needs dist/ from `npm run fetch && npm run build`.
const dist = new URL("../dist/", import.meta.url);
const zones = async (lat: number, lon: number) => (await whereAmI(lat, lon)).map((z) => `${z.layer}:${z.iso_ter}`);

afterEach(() => configure({ dir: dist }));

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

test("a tile that was built but is not on disk throws instead of answering short", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maritime-zones-"));
  for (const file of ["zones.json", "tiles.json"]) copyFileSync(new URL(file, dist), join(dir, file));
  configure({ dir });
  await expect(whereAmI(51.25, 2.85)).rejects.toMatchObject({ code: "MISSING_TILE", tile: "n50e0" });
});
