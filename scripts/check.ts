/**
 * Check the query API against independent answers (not run in CI):
 *   - whereAmI against the live VLIZ WFS (INTERSECTS on each zone layer)
 *   - distanceToLand and nearestTerritory against exact distances: GDAL
 *     reprojects nearby lines to azimuthal equidistant around the point, where
 *     planar ST_Distance from the origin is the geodesic distance
 *
 *   node scripts/check.ts [points=100]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure, distanceToLand, nearestTerritory, whereAmI } from "../src/index.ts";
import { box as circleBox, TILE, tiles } from "../src/tiles.ts";
import { DIST, LAYERS, WFS } from "./layers.ts";

console.debug = () => {};
configure({ cacheDir: join(DIST, "tiles"), download: false });
const count = Number(process.argv[2] ?? 100);
const work = mkdtempSync(join(tmpdir(), "maritime-zones-check-"));
const zoneLayers = LAYERS.filter((l) => l.key !== "land");

let seed = 1;
const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

/** mrgids of every zone layer containing the point, per the WFS. */
async function upstream(lat: number, lon: number): Promise<Set<string>> {
  const found = new Set<string>();
  for (const { key, typeName } of zoneLayers) {
    const filter = encodeURIComponent(`INTERSECTS(the_geom,POINT(${lon} ${lat}))`);
    const url = `${WFS}?service=WFS&version=1.0.0&request=GetFeature&typeName=MarineRegions:${typeName}&outputFormat=application/json&propertyName=mrgid&cql_filter=${filter}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`WFS ${response.status}`);
    for (const f of (await response.json()).features) found.add(`${key}:${f.properties.mrgid ?? 0}`);
  }
  return found;
}

const table: { layer: string; iso_ter: string | null }[] = JSON.parse(readFileSync(join(DIST, "zones.json"), "utf8"));

/**
 * Exact minimum distance in NM from the point to features matching `where`
 * within r degrees. Reads one extra ring of tiles beyond what the reader
 * would, so a feature missing from a tile it touches shows up as a mismatch.
 */
function oracle(lat: number, lon: number, r: number, where: string): number | null {
  const [minX, minY, maxX, maxY] = circleBox({ lat, lon, radiusNm: r * 60 });
  const box = [Math.max(-180, minX), minY, Math.min(180, maxX), maxY] as const;
  const cut = join(work, "cut.sqlite");
  rmSync(cut, { force: true });
  let first = true;
  for (const tile of tiles([box[0] - TILE, box[1] - TILE, box[2] + TILE, box[3] + TILE])) {
    const file = join(DIST, "tiles", `${tile}.fgb`);
    if (!existsSync(file)) continue;
    execFileSync("ogr2ogr", [
      ...(first ? ["-f", "SQLite", "-dsco", "SPATIALITE=YES"] : ["-append"]),
      "-nln",
      "cut",
      "-nlt",
      "GEOMETRY",
      "-where",
      where,
      "-spat",
      ...box.map(String),
      // Azimuthal equidistant around the query point: planar distance from the
      // origin is the ellipsoidal geodesic distance.
      "-t_srs",
      `+proj=aeqd +lat_0=${lat} +lon_0=${lon} +ellps=WGS84 +units=m`,
      cut,
      file,
    ]);
    first = false;
  }
  if (first) return null;
  const out = execFileSync("ogrinfo", [
    "-ro",
    "-q",
    cut,
    "-sql",
    "SELECT MIN(ST_Distance(GEOMETRY, MakePoint(0, 0)))/1852 AS nm FROM cut",
  ]).toString();
  const nm = out.match(/nm \(Real\) = ([\d.]+)/)?.[1];
  return nm ? Number(nm) : null;
}

const zonesWhere = (keep: (z: (typeof table)[number]) => boolean) =>
  `kind = 'boundary' AND zone IN (${table.flatMap((z, i) => (keep(z) ? [i] : [])).join(",") || -1})`;

let zoneMismatches = 0;
let worstLand = 0;
let worstTerritory = 0;
for (let i = 0; i < count; i++) {
  const lat = random() * 140 - 70;
  const lon = random() * 360 - 180;
  const mine = new Set((await whereAmI(lat, lon)).map((z) => `${z.layer}:${z.mrgid ?? 0}`));
  const theirs = await upstream(lat, lon);
  if ([...mine].sort().join() !== [...theirs].sort().join()) {
    zoneMismatches++;
    console.log(`zones differ at ${lat.toFixed(4)},${lon.toFixed(4)}: ours ${[...mine]} upstream ${[...theirs]}`);
  }

  const land = await distanceToLand(lat, lon);
  if (land) {
    const truth = oracle(lat, lon, land.distanceNm / 60 + 0.1, "kind = 'land'");
    const error = truth == null ? Infinity : Math.abs(land.distanceNm - truth) / Math.max(truth, 0.1);
    worstLand = Math.max(worstLand, error);
    if (error > 0.01)
      console.log(
        `land differs at ${lat.toFixed(4)},${lon.toFixed(4)}: ours ${land.distanceNm.toFixed(3)} oracle ${truth}`,
      );
  }

  const next = await nearestTerritory(lat, lon);
  if (next) {
    const here = (await whereAmI(lat, lon)).find((z) => z.iso_ter)?.iso_ter;
    const where = zonesWhere(
      (z) => ["internal", "archipelagic", "12nm"].includes(z.layer) && z.iso_ter != null && z.iso_ter !== here,
    );
    const truth = oracle(lat, lon, next.distanceNm / 60 + 0.1, where);
    const error = truth == null ? Infinity : Math.abs(next.distanceNm - truth) / Math.max(truth, 0.1);
    worstTerritory = Math.max(worstTerritory, error);
    if (error > 0.01)
      console.log(
        `territory differs at ${lat.toFixed(4)},${lon.toFixed(4)}: ours ${next.distanceNm.toFixed(3)} oracle ${truth}`,
      );
  }
}

console.log(
  `${count} points: ${zoneMismatches} zone mismatches, worst land error ${(worstLand * 100).toFixed(2)}%, worst territory error ${(worstTerritory * 100).toFixed(2)}%`,
);
process.exitCode = zoneMismatches || worstLand > 0.01 || worstTerritory > 0.01 ? 1 : 0;
