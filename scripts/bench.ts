/** Time the queries over random positions and print a few fixed ones. */
import { distanceTo, distanceToLand, nearestTerritory, whereAmI } from "../src/index.ts";

const fixed: [string, number, number][] = [
  ["Off Ostend", 51.25, 2.85],
  ["Mid North Atlantic", 40, -40],
  ["Haro Strait", 48.6, -123.2],
  ["Dover", 51.1, 1.4],
  ["Taveuni, Fiji", -16.8, 179.99],
];
for (const [label, lat, lon] of fixed) {
  const zones = (await whereAmI(lat, lon)).map((z) => `${z.layer}:${z.iso_ter}`);
  const next = await nearestTerritory(lat, lon);
  const land = await distanceToLand(lat, lon);
  const bel = await distanceTo(lat, lon, "BEL");
  console.log(label, zones.join(" "), {
    next: next && `${next.zone?.iso_ter} ${next.distanceNm.toFixed(2)} NM @ ${next.bearingDeg.toFixed(0)}°`,
    land: land && `${land.distanceNm.toFixed(2)} NM`,
    bel: bel && `${bel.distanceNm.toFixed(1)} NM`,
  });
}

let seed = 42;
const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const points = Array.from({ length: 1000 }, () => [random() * 140 - 70, random() * 360 - 180] as const);
for (const [name, fn] of [
  ["whereAmI", whereAmI],
  ["nearestTerritory", nearestTerritory],
  ["distanceToLand", distanceToLand],
] as const) {
  const start = performance.now();
  for (const [lat, lon] of points) await fn(lat, lon);
  console.log(`${name}: ${((performance.now() - start) / points.length).toFixed(2)} ms avg`);
}
