/**
 * Turn the tmp/ WFS cache into 10° tiles of FlatGeobuf in dist/tiles/, so a
 * consumer downloads only the area it sails in.
 *
 * Each tile holds three kinds of feature, told apart by the `kind` attribute:
 *
 *   zone      zone polygons, subdivided into pieces of at most MAX_VERTICES so
 *             a point lookup decodes a few small pieces instead of a whole
 *             country. Only for point-in-polygon: the cuts add edges that are
 *             not real boundaries.
 *   boundary  the real zone rings as LineStrings of at most CHUNK vertices,
 *             for distances.
 *   land      OpenStreetMap coastline lines, chunked the same way.
 *
 * Features are not clipped at tile edges: each one goes into every tile its
 * bbox touches, so a query that reads the tiles under its search box sees
 * everything and distances across tile edges stay exact. Zone and boundary
 * features carry `zone`, an index into dist/zones.json, which holds each
 * zone's metadata once. dist/tiles.json lists every tile with its size and
 * hash.
 *
 * GDAL writes the files (ogr2ogr builds the packed Hilbert R-tree index; the
 * flatgeobuf npm writer does not).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { TILE, tiles } from "../src/tiles.ts";
import { DIST, LAYERS, TMP } from "./layers.ts";

const MAX_VERTICES = 256;
const CHUNK = 256;
/** Douglas–Peucker tolerance in degrees (~11 m of latitude). */
const TOLERANCE = Number(process.env.TOLERANCE ?? 0.0001);
const round = (n: number) => Math.round(n * 1e5) / 1e5;

type Point = [number, number];
type Ring = Point[];
type Box = [number, number, number, number];

/**
 * Douglas–Peucker in plain degrees. Neighbouring zones are simplified apart,
 * so shared edges can open slivers up to TOLERANCE wide.
 * ponytail: degrees, not metres; longitude tolerance tightens toward the poles, which only costs size.
 */
function simplify(ring: Ring): Ring {
  if (!TOLERANCE || ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    const [ax, ay] = ring[first]!;
    const [bx, by] = ring[last]!;
    const dx = bx - ax,
      dy = by - ay;
    const length2 = dx * dx + dy * dy;
    let worst = 0,
      index = 0;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = ring[i]!;
      const t = length2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2)) : 0;
      const d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      if (d > worst) ((worst = d), (index = i));
    }
    if (worst > TOLERANCE * TOLERANCE) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

/** Sutherland–Hodgman clip of a closed ring to an axis-aligned box. */
function clip(ring: Ring, [minLon, minLat, maxLon, maxLat]: Box): Ring {
  const edges: [(p: Point) => boolean, number, 0 | 1][] = [
    [([x]) => x >= minLon, minLon, 0],
    [([x]) => x <= maxLon, maxLon, 0],
    [([, y]) => y >= minLat, minLat, 1],
    [([, y]) => y <= maxLat, maxLat, 1],
  ];
  let output = ring.slice(0, -1);
  for (const [inside, value, axis] of edges) {
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i]!;
      const previous = input[(i + input.length - 1) % input.length]!;
      const crossing = (): Point => {
        const t = (value - previous[axis]) / (current[axis] - previous[axis]);
        return axis === 0
          ? [value, previous[1] + t * (current[1] - previous[1])]
          : [previous[0] + t * (current[0] - previous[0]), value];
      };
      if (inside(current)) {
        if (!inside(previous)) output.push(crossing());
        output.push(current);
      } else if (inside(previous)) output.push(crossing());
    }
    if (!output.length) return [];
  }
  output.push(output[0]!);
  return output;
}

function bbox(ring: Ring): Box {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** Split a polygon in half along its longer side until every piece is small. */
function subdivide(rings: Ring[], box = bbox(rings[0]!), depth = 0): Ring[][] {
  const vertices = rings.reduce((sum, ring) => sum + ring.length, 0);
  // ponytail: depth cap stops runaway recursion on pathological vertex clusters.
  if (vertices <= MAX_VERTICES || depth >= 24) return [rings];
  const [minX, minY, maxX, maxY] = box;
  const halves: Box[] =
    maxX - minX >= maxY - minY
      ? [
          [minX, minY, (minX + maxX) / 2, maxY],
          [(minX + maxX) / 2, minY, maxX, maxY],
        ]
      : [
          [minX, minY, maxX, (minY + maxY) / 2],
          [minX, (minY + maxY) / 2, maxX, maxY],
        ];
  return halves.flatMap((half) => {
    const [outer, ...holes] = rings.map((ring) => clip(ring, half));
    if (!outer || outer.length < 4) return [];
    return subdivide([outer, ...holes.filter((h) => h.length >= 4)], half, depth + 1);
  });
}

/** A closed ring as LineStrings of at most CHUNK vertices, sharing endpoints. */
function chunk(ring: Ring): Ring[] {
  const lines: Ring[] = [];
  for (let i = 0; i < ring.length - 1; i += CHUNK - 1) lines.push(ring.slice(i, i + CHUNK));
  return lines;
}

function* features(key: string) {
  const dir = join(TMP, key);
  for (const file of readdirSync(dir).sort()) {
    yield* JSON.parse(readFileSync(join(dir, file), "utf8")).features;
  }
}

function polygons(geometry: { type: string; coordinates: unknown }): Ring[][] {
  if (!geometry) return [];
  const polys = (geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates]) as Ring[][];
  return polys
    .map((rings) => rings.map((ring) => simplify(ring.map(([x, y]): Point => [round(x), round(y)]))))
    .filter((rings) => rings[0]!.length >= 4)
    .map(([outer, ...holes]) => [outer!, ...holes.filter((ring) => ring.length >= 4)]);
}

function properties(layer: string, p: Record<string, any>) {
  return {
    layer,
    mrgid: p.mrgid ?? null,
    name: p.geoname ?? p.name ?? null,
    territory: p.territory1 ?? null,
    iso_ter: p.iso_ter1 ?? p.iso_sov1 ?? null,
    sovereign: p.sovereign1 ?? null,
    iso_sov: p.iso_sov1 ?? null,
    mrgid_eez: p.mrgid_eez ?? null,
    iso_ter2: p.iso_ter2 ?? null,
    iso_sov2: p.iso_sov2 ?? null,
    iso_ter3: p.iso_ter3 ?? null,
    iso_sov3: p.iso_sov3 ?? null,
  };
}

/** Buffered appends to one GeoJSONSeq file per tile, without holding hundreds of file handles open. */
const pending = new Map<string, string[]>();
let buffered = 0;
function flush() {
  for (const [tile, lines] of pending) appendFileSync(join(TMP, "tiles", `${tile}.geojsonl`), lines.join(""));
  pending.clear();
  buffered = 0;
}
function write(properties: object, type: string, coordinates: Ring | Ring[]) {
  const ring = (type === "Polygon" ? coordinates[0] : coordinates) as Ring;
  const line = JSON.stringify({ type: "Feature", properties, geometry: { type, coordinates } }) + "\n";
  for (const tile of tiles(bbox(ring))) {
    let lines = pending.get(tile);
    if (!lines) pending.set(tile, (lines = []));
    lines.push(line);
    buffered += line.length;
  }
  if (buffered > 256e6) flush();
}

rmSync(join(TMP, "tiles"), { recursive: true, force: true });
mkdirSync(join(TMP, "tiles"), { recursive: true });
const table: ReturnType<typeof properties>[] = [];

for (const { key } of LAYERS) {
  for (const feature of features(key)) {
    table.push(properties(key, feature.properties));
    const zone = table.length - 1;
    for (const rings of polygons(feature.geometry)) {
      for (const piece of subdivide(rings)) write({ kind: "zone", zone }, "Polygon", piece);
      for (const ring of rings) for (const line of chunk(ring)) write({ kind: "boundary", zone }, "LineString", line);
    }
  }
  console.log(`${key}: ${table.length} zones`);
}
for await (const line of createInterface({
  input: createReadStream(join(TMP, "coastlines.geojsonl")),
  crlfDelay: Infinity,
})) {
  if (!line) continue;
  const { geometry } = JSON.parse(line);
  if (geometry?.type !== "LineString") throw new Error("OSM coastline must be a LineString");
  const points = simplify(geometry.coordinates.map(([x, y]: Point): Point => [round(x), round(y)]));
  // GDAL boundary filters need the zone field even in coastline-only tiles.
  for (const part of chunk(points)) write({ kind: "land", zone: null }, "LineString", part);
}
flush();

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, "tiles"), { recursive: true });
writeFileSync(join(DIST, "zones.json"), JSON.stringify(table) + "\n");
const index: Record<string, { bytes: number; sha256: string }> = {};
for (const file of readdirSync(join(TMP, "tiles")).sort()) {
  const tile = file.replace(".geojsonl", "");
  const out = join(DIST, "tiles", `${tile}.fgb`);
  execFileSync("ogr2ogr", [
    "-f",
    "FlatGeobuf",
    "-a_srs",
    "EPSG:4326",
    "-nlt",
    "GEOMETRY",
    "-lco",
    "SPATIAL_INDEX=YES",
    "-nln",
    tile,
    out,
    join(TMP, "tiles", file),
  ]);
  execFileSync("t2sz", ["-r", "-s", "256K", "-l", "19", out]);
  const bytes = readFileSync(`${out}.zst`);
  index[tile] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
writeFileSync(join(DIST, "tiles.json"), JSON.stringify({ tile: TILE, tiles: index }, null, 1) + "\n");
const sizes = Object.values(index)
  .map((t) => t.bytes)
  .sort((a, b) => b - a);
console.log(
  `Wrote ${sizes.length} tiles, ${(sizes.reduce((a, b) => a + b, 0) / 1e6).toFixed(0)} MB total, ` +
    `largest ${(sizes[0]! / 1e6).toFixed(1)} MB, median ${(sizes[sizes.length >> 1]! / 1e6).toFixed(2)} MB`,
);
