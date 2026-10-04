import { ArrayReader } from "flatgeobuf/lib/mjs/array-reader.js";
import { fromFeature } from "./feature.ts";
import { fetchAll, listed, load, zoneTable } from "./store.ts";
import { type Area, tilesIn } from "./tiles.ts";
import { createQueries, type Zone } from "./queries.ts";

export { configure, type Config } from "./store.ts";
export type { Area } from "./tiles.ts";
export type { Layer, Zone, Hit, Options } from "./queries.ts";
export type { AheadOptions, AheadResult, Crossing } from "./ahead.ts";

export const { whereAmI, nearestTerritory, distanceTo, distanceToLand, ahead } = createQueries(
  async function* (tile, rect, kind) {
    const reader = ArrayReader.open(await load(tile));
    for await (const { id, feature } of reader.selectBbox(rect)) {
      const decoded = fromFeature(id, feature, reader.header, kind);
      if (decoded) yield decoded;
    }
  },
  listed,
  () => zoneTable<Zone>(),
);

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
