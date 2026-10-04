import { box, tiles, wrapped } from "./tiles.ts";
import type { QueryGeometry } from "./feature.ts";
import { createAhead, EARTH_NM, LAYERS, RAD, SOVEREIGN, wrap } from "./ahead.ts";

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

export type Rect = { minX: number; minY: number; maxX: number; maxY: number };

/** The same query math for offline files and browser range reads. */
export function createQueries(
  read: (tile: string, rect: Rect, kind: string) => AsyncIterable<unknown>,
  listed: () => Record<string, unknown>,
  zones: () => Zone[],
) {
  /** Past this search radius (degrees of latitude, ~480 NM) nothing counts as near. */
  const MAX_RADIUS = 8;

  type Point = [number, number];

  type Kind = "zone" | "boundary" | "land";
  type Found = { zone: number | undefined; geometry: QueryGeometry };

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
        for await (const f of read(tile, rect, kind)) {
          const feature = f as unknown as {
            properties: { kind: Kind; zone?: number };
            geometry: QueryGeometry;
          };
          if (feature.properties.kind === kind)
            found.push({ zone: feature.properties.zone, geometry: feature.geometry });
        }
      }
    }
    return found;
  }

  /** Even–odd ray test over all rings, so holes subtract. */
  function contains({ xy, ends }: QueryGeometry, x: number, y: number): boolean {
    let inside = false;
    let start = 0;
    for (let ring = 0; ring < (ends?.length || 1); ring++) {
      const end = ends?.length ? ends[ring]! * 2 : xy.length;
      for (let i = start, j = end - 2; i < end; j = i, i += 2) {
        const xi = xy[i]!,
          yi = xy[i + 1]!;
        const xj = xy[j]!,
          yj = xy[j + 1]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      start = end;
    }
    return inside;
  }

  /** Every zone containing the point, innermost first. */
  async function whereAmI(lat: number, lon: number): Promise<Zone[]> {
    const e = 1e-7;
    const hits = new Set<number>();
    for (const f of await query("zone", lon - e, lat - e, lon + e, lat + e)) {
      if (contains(f.geometry, lon, lat)) hits.add(f.zone!);
    }
    return [...hits].map((i) => zones()[i]!).sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer));
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
    const x =
      Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos(dLon);
    return (((Math.atan2(y, x) / RAD) % 360) + 360) % 360;
  }

  /**
   * Closest point on a line to [lat, lon]. The closest point is found in a local
   * equirectangular projection and measured with haversine.
   * ponytail: projection error grows with distance; fine inside MAX_RADIUS.
   */
  function closest({ xy }: QueryGeometry, lat: number, lon: number): [number, Point] {
    const k = Math.cos(lat * RAD);
    let best: [number, Point] = [Infinity, [lat, lon]];
    let bestPlanar = Infinity;
    for (let i = 2; i < xy.length; i += 2) {
      const ax = wrap(xy[i - 2]! - lon) * k,
        ay = xy[i - 1]! - lat;
      const bx = wrap(xy[i]! - lon) * k,
        by = xy[i + 1]! - lat;
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
    for (let r = 0.25; ;) {
      let best: Hit | null = null;
      for (const f of await query(kind, ...box({ lat, lon, radiusNm: r * 60 }))) {
        const zone = kind === "land" ? null : zones()[f.zone!]!;
        if (!keep(zone)) continue;
        const [distanceNm, point] = closest(f.geometry, lat, lon);
        if (!best || distanceNm < best.distanceNm)
          best = { distanceNm, bearingDeg: bearing([lat, lon], point), point, zone };
      }
      // Anything within r degrees of latitude (r × 60 NM) is inside this box, so a hit that close is final.
      if (best && best.distanceNm <= r * 60) return best;
      if (r >= MAX_RADIUS) return null;
      // A hit at d NM beyond the box bounds the answer: the next box only needs to reach d, not 2r.
      // The margin keeps the same hit inside its own box despite rounding.
      r = Math.min(MAX_RADIUS, best ? best.distanceNm / 60 + 1e-6 : r * 2);
    }
  }

  /** Nearest point of another territory's waters (default: sovereign waters). */
  async function nearestTerritory(lat: number, lon: number, { layers = SOVEREIGN }: Options = {}): Promise<Hit | null> {
    const here = (await whereAmI(lat, lon)).find((z) => z.iso_ter)?.iso_ter ?? null;
    return nearest(
      "boundary",
      lat,
      lon,
      (z) => !!z && layers.includes(z.layer) && z.iso_ter != null && z.iso_ter !== here,
    );
  }

  /** Distance to territory X's waters (default: sovereign waters); 0 when already inside them. */
  async function distanceTo(
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
  async function distanceToLand(lat: number, lon: number): Promise<Hit | null> {
    return nearest("land", lat, lon, () => true);
  }

  return { whereAmI, nearestTerritory, distanceTo, distanceToLand, ahead: createAhead(read, listed, zones, whereAmI) };
}
