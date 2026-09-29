/** Tile size in degrees; must divide 90 and 180. */
export const TILE = 10;

/** Tile names for a bbox: "n40w130" is the tile from 40°N 130°W to 50°N 120°W. */
export function tiles([minX, minY, maxX, maxY]: [number, number, number, number]): string[] {
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
