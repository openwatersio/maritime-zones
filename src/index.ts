import { deserialize } from "flatgeobuf/lib/mjs/geojson.js";
import { fetchAll, listed, load, zoneTable } from "./store.ts";
import { type Area, box, tiles, tilesIn, wrapped } from "./tiles.ts";

export { configure, type Config } from "./store.ts";
export type { Area } from "./tiles.ts";

export type Layer = "internal" | "archipelagic" | "12nm" | "24nm" | "eez" | "high_seas";

export interface Zone {
  layer: Layer;
  mrgid: number;
  name: string;
  territory: string | null;
  /** ISO 3166-1 alpha-3 of the territory, or of the sovereign when the territory has none. */
  iso_ter: string | null;
  sovereign: string | null;
  iso_sov: string | null;
  mrgid_eez: number | null;
  /** Second and third parties of a joint regime or overlapping claim. */
  iso_ter2: string | null;
  iso_sov2: string | null;
  iso_ter3: string | null;
  iso_sov3: string | null;
}

export interface Hit {
  distanceNm: number;
  /** Initial great-circle bearing from the query point, degrees true. */
  bearingDeg: number;
  /** Nearest point, [lat, lon]. */
  point: [number, number];
  zone: Zone | null;
}

export interface Options {
  /** Which zone layers count as the territory. Default: sovereign waters (internal, archipelagic, 12 NM). */
  layers?: Layer[];
}

const SOVEREIGN: Layer[] = ["internal", "archipelagic", "12nm"];

const ORDER: Layer[] = ["internal", "archipelagic", "12nm", "24nm", "eez", "high_seas"];
const EARTH_NM = 3440.065;
const RAD = Math.PI / 180;
/** Past this search radius (degrees of latitude, ~480 NM) nothing counts as near. */
const MAX_RADIUS = 8;

type Point = [number, number];

const zones = () => zoneTable<Zone>();

/** The tiles an area needs and their download sizes. Tiles with no features are left out. */
export function tilesFor(area: Area): { tile: string; bytes: number }[] {
  return tilesIn(area).flatMap((tile) => (listed()[tile] ? [{ tile, bytes: listed()[tile]!.bytes }] : []));
}

/**
 * Download the tiles an area needs into the cache ahead of time, for example
 * before a passage without signal. Queries download missing tiles on their own
 * unless downloads are off. Add the search radius you care about to the area:
 * a query 100 NM from its edge can need tiles outside it.
 */
export async function download(area: Area): Promise<{ tiles: number; bytes: number }> {
  const needed = tilesFor(area);
  await fetchAll(needed.map((t) => t.tile));
  return { tiles: needed.length, bytes: needed.reduce((sum, t) => sum + t.bytes, 0) };
}

type Kind = "zone" | "boundary" | "land";
type Found = { zone: number | undefined; coordinates: any };

/**
 * Features of one kind whose bbox meets the box, across every tile under it.
 * A box that crosses ±180 is also tried shifted by ±360, so features on the
 * far side of the antimeridian are found.
 */
async function query(kind: Kind, minX: number, minY: number, maxX: number, maxY: number): Promise<Found[]> {
  const found: Found[] = [];
  for (const box of wrapped([minX, minY, maxX, maxY])) {
    const rect = { minX: box[0], minY: box[1], maxX: box[2], maxY: box[3] };
    for (const tile of tiles(box)) {
      if (!listed()[tile]) continue;
      for await (const f of deserialize(await load(tile), { rect })) {
        const { properties, geometry } = f as unknown as {
          properties: { kind: Kind; zone?: number };
          geometry: { coordinates: any };
        };
        if (properties.kind === kind) found.push({ zone: properties.zone, coordinates: geometry.coordinates });
      }
    }
  }
  return found;
}

/** Even–odd ray test over all rings, so holes subtract. */
function contains(rings: Point[][], [x, y]: Point): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Every zone containing the point, innermost first. */
export async function whereAmI(lat: number, lon: number): Promise<Zone[]> {
  const e = 1e-7;
  const hits = new Set<number>();
  for (const f of await query("zone", lon - e, lat - e, lon + e, lat + e)) {
    if (contains(f.coordinates, [lon, lat])) hits.add(f.zone!);
  }
  return [...hits].map((i) => zones()[i]!).sort((a, b) => ORDER.indexOf(a.layer) - ORDER.indexOf(b.layer));
}

function haversine([lat1, lon1]: Point, [lat2, lon2]: Point): number {
  const a =
    Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearing([lat1, lon1]: Point, [lat2, lon2]: Point): number {
  const dLon = (lon2 - lon1) * RAD;
  const y = Math.sin(dLon) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos(dLon);
  return (((Math.atan2(y, x) / RAD) % 360) + 360) % 360;
}

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/**
 * Closest point on a line to [lat, lon]. The closest point is found in a local
 * equirectangular projection and measured with haversine.
 * ponytail: projection error grows with distance; fine inside MAX_RADIUS.
 */
function closest(line: Point[], lat: number, lon: number): [number, Point] {
  const k = Math.cos(lat * RAD);
  let best: [number, Point] = [Infinity, [lat, lon]];
  let bestPlanar = Infinity;
  for (let i = 1; i < line.length; i++) {
    const ax = wrap(line[i - 1]![0] - lon) * k,
      ay = line[i - 1]![1] - lat;
    const bx = wrap(line[i]![0] - lon) * k,
      by = line[i]![1] - lat;
    const dx = bx - ax,
      dy = by - ay;
    const t = Math.max(0, Math.min(1, dx || dy ? -(ax * dx + ay * dy) / (dx * dx + dy * dy) : 0));
    const px = ax + t * dx,
      py = ay + t * dy;
    const planar = px * px + py * py;
    if (planar < bestPlanar) {
      bestPlanar = planar;
      best = [0, [lat + py, wrap(lon + px / k)]];
    }
  }
  best[0] = haversine([lat, lon], best[1]);
  return best;
}

/** Nearest line in a file, searching outward until the box holds the answer. */
async function nearest(kind: "boundary" | "land", lat: number, lon: number, keep: (zone: Zone | null) => boolean) {
  for (let r = 0.25; r <= MAX_RADIUS; r *= 2) {
    let best: Hit | null = null;
    for (const f of await query(kind, ...box({ lat, lon, radiusNm: r * 60 }))) {
      const zone = kind === "land" ? null : zones()[f.zone!]!;
      if (!keep(zone)) continue;
      const [distanceNm, point] = closest(f.coordinates, lat, lon);
      if (!best || distanceNm < best.distanceNm)
        best = { distanceNm, bearingDeg: bearing([lat, lon], point), point, zone };
    }
    // Anything within r degrees of latitude (r × 60 NM) is inside this box, so a hit that close is final.
    if (best && best.distanceNm <= r * 60) return best;
  }
  return null;
}

/** Nearest point of another territory's waters (default: sovereign waters). */
export async function nearestTerritory(
  lat: number,
  lon: number,
  { layers = SOVEREIGN }: Options = {},
): Promise<Hit | null> {
  const here = (await whereAmI(lat, lon)).find((z) => z.iso_ter)?.iso_ter ?? null;
  return nearest(
    "boundary",
    lat,
    lon,
    (z) => !!z && layers.includes(z.layer) && z.iso_ter != null && z.iso_ter !== here,
  );
}

/** Distance to territory X's waters (default: sovereign waters); 0 when already inside them. */
export async function distanceTo(
  lat: number,
  lon: number,
  isoTer: string,
  { layers = SOVEREIGN }: Options = {},
): Promise<Hit | null> {
  const inside = (await whereAmI(lat, lon)).find((z) => layers.includes(z.layer) && z.iso_ter === isoTer);
  if (inside) return { distanceNm: 0, bearingDeg: 0, point: [lat, lon], zone: inside };
  return nearest("boundary", lat, lon, (z) => !!z && layers.includes(z.layer) && z.iso_ter === isoTer);
}

/** Distance to the nearest coastline. */
export async function distanceToLand(lat: number, lon: number): Promise<Hit | null> {
  return nearest("land", lat, lon, () => true);
}
