import { expect, test } from "vitest";
import { box, tilesIn } from "../src/tiles.ts";

test("a circle that reaches a pole spans every longitude", () => {
  // 120 NM around 89°N 0°: 89.5°N 180° is 90 NM away, across the pole.
  const names = tilesIn({ lat: 89, lon: 0, radiusNm: 120 });
  expect(names).toContain("n80w180");
  expect(names).toContain("n80e170");
  expect(names.filter((t) => t.startsWith("n80"))).toHaveLength(36);
});

test("a high-latitude circle uses the spherical longitude span", () => {
  // 300 NM (5°) around 80°N 0°: the widest point is asin(sin 5° / cos 80°) = 30.1° east.
  const [minX, , maxX] = box({ lat: 80, lon: 0, radiusNm: 300 });
  expect(maxX).toBeCloseTo(30.1, 1);
  expect(minX).toBeCloseTo(-30.1, 1);
  expect(tilesIn({ lat: 80, lon: 0, radiusNm: 300 })).toContain("n80e30");
});

test("a circle at the equator spans its radius in longitude", () => {
  expect(box({ lat: 0, lon: 10, radiusNm: 60 })).toEqual([9, -1, 11, 1]);
});
