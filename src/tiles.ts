/** Tile size in degrees; must divide 90 and 180. */
export const TILE = 10;

type Box = [number, number, number, number];

/** A box in degrees, or a circle around a position. */
export type Area =
  { minLat: number; minLon: number; maxLat: number; maxLon: number } | { lat: number; lon: number; radiusNm: number };

/** Tile names for a bbox: "n40w130" is the tile from 40°N 130°W to 50°N 120°W. Longitudes past ±180 clamp. */
export function tiles([minX, minY, maxX, maxY]: Box): string[] {
  const names: string[] = [];
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const y0 = clamp(Math.floor(minY / TILE), -90 / TILE, 90 / TILE - 1);
  const y1 = clamp(Math.floor(maxY / TILE), -90 / TILE, 90 / TILE - 1);
  const x0 = clamp(Math.floor(minX / TILE), -180 / TILE, 180 / TILE - 1);
  const x1 = clamp(Math.floor(maxX / TILE), -180 / TILE, 180 / TILE - 1);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const lat = y * TILE,
        lon = x * TILE;
      names.push(`${lat < 0 ? "s" : "n"}${Math.abs(lat)}${lon < 0 ? "w" : "e"}${Math.abs(lon)}`);
    }
  return names;
}

/**
 * The box, plus its copies shifted by ±360 when it crosses ±180, so a search
 * near the antimeridian also covers the far side.
 */
export function wrapped([minX, minY, maxX, maxY]: Box): Box[] {
  return [0, 360, -360]
    .map((shift): Box => [minX + shift, minY, maxX + shift, maxY])
    .filter(([a, , b]) => b >= -185 && a <= 185);
}

/** The bbox of an area. A circle's longitude span widens with latitude, up to the whole globe near the poles. */
export function box(area: Area): Box {
  if ("radiusNm" in area) {
    const r = area.radiusNm / 60;
    const rLon = Math.min(180, r / Math.max(Math.cos((area.lat * Math.PI) / 180), 1e-6));
    return [area.lon - rLon, Math.max(-90, area.lat - r), area.lon + rLon, Math.min(90, area.lat + r)];
  }
  return [area.minLon, area.minLat, area.maxLon, area.maxLat];
}

/** Every tile under an area, including across the antimeridian, without duplicates. */
export function tilesIn(area: Area): string[] {
  return [...new Set(wrapped(box(area)).flatMap(tiles))];
}
