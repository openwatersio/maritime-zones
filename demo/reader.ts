import { fromFeature } from "../src/feature.ts";
import { HttpReader } from "flatgeobuf/lib/mjs/http-reader.js";
import { SeekableZstdReader } from "flatgeobuf/lib/mjs/seekable-zstd.js";
import { createQueries, type Rect, type Zone } from "../src/queries.ts";
import { tiles, wrapped } from "../src/tiles.ts";

declare const TILE_VERSION: string;
export const version = TILE_VERSION;
const base = new URL(`./${version}/`, import.meta.url);
type Metadata = { tiles: Record<string, { bytes: number; sha256: string }>; zones: Zone[] };
let pending: Promise<Metadata> | undefined;

export function metadata(): Promise<Metadata> {
  pending ??= Promise.all(
    ["tiles.json", "zones.json"].map(async (file) => {
      const response = await fetch(new URL(file, base));
      if (!response.ok) throw new Error(`Could not load ${file}: HTTP ${response.status}`);
      return response.json();
    }),
  )
    .then(([index, zones]) => ({ tiles: index.tiles, zones }))
    .catch((error) => {
      pending = undefined;
      throw error;
    });
  return pending;
}

let wasm: Promise<string> | undefined;
function wasmUrl() {
  // The codec never rejects a failed initialization; fetch first so Retry remains usable.
  wasm ??= fetch(new URL("./zstd.wasm", import.meta.url))
    .then(async (response) => {
      if (!response.ok) throw new Error(`Could not load zstd.wasm: HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (!WebAssembly.validate(bytes)) throw new Error("Invalid zstd.wasm");
      return URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
    })
    .catch((error) => {
      wasm = undefined;
      throw error;
    });
  return wasm;
}
async function* read(tile: string, rect: Rect, kind?: string) {
  const codecUrl = await wasmUrl();
  const source = await SeekableZstdReader.open(new URL(`${tile}.fgb.zst`, base).href, false, {}, codecUrl);
  const reader = await HttpReader.openSource(source);
  for await (const { id, feature } of reader.selectBbox(rect)) {
    const decoded = fromFeature(id, feature, reader.header, kind);
    if (decoded) yield decoded;
  }
}
async function reader() {
  const data = await metadata();
  return createQueries(
    read,
    () => data.tiles,
    () => data.zones,
  );
}

export async function whereAmI(lat: number, lon: number) {
  return (await reader()).whereAmI(lat, lon);
}
export async function nearestTerritory(lat: number, lon: number) {
  return (await reader()).nearestTerritory(lat, lon);
}
export async function distanceTo(lat: number, lon: number, iso: string) {
  return (await reader()).distanceTo(lat, lon, iso);
}
export async function distanceToLand(lat: number, lon: number) {
  return (await reader()).distanceToLand(lat, lon);
}

/** Nearby zone pieces for the map; the four answers use the shared query engine. */
export async function zoneFeatures(rect: Rect, ids: Set<number>) {
  const data = await metadata();
  const found = [];
  const seen = new Set<string>();
  for (const bounds of wrapped([rect.minX, rect.minY, rect.maxX, rect.maxY])) {
    const area = { minX: bounds[0], minY: bounds[1], maxX: bounds[2], maxY: bounds[3] };
    for (const tile of tiles(bounds)) {
      if (!data.tiles[tile]) continue;
      for await (const feature of read(tile, area)) {
        const id = feature.properties?.zone;
        if (feature.properties?.kind !== "zone" || !ids.has(id)) continue;
        const key = JSON.stringify(feature.geometry);
        if (!seen.has(key)) {
          seen.add(key);
          found.push(feature);
        }
      }
    }
  }
  return found;
}
