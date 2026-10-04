import { parseProperties } from "flatgeobuf/lib/mjs/generic/feature.js";
import { fromGeometry } from "flatgeobuf/lib/mjs/geojson/geometry.js";
import type { fromFeature as decodeFeature } from "flatgeobuf/lib/mjs/geojson/feature.js";
import type { IFeature } from "flatgeobuf/lib/mjs/generic/feature.js";

export type QueryGeometry = { xy: Float64Array; ends: Uint32Array | null };
interface QueryFeature extends IFeature {
  type: "Feature";
  id: number;
  properties: { kind: string; zone: number };
  geometry: QueryGeometry;
}
type RawFeature = Parameters<typeof decodeFeature>[1];
type Header = Parameters<typeof decodeFeature>[2];
type GeoJsonFeature = ReturnType<typeof decodeFeature>;

export function fromFeature(id: number, feature: RawFeature, header: Header): GeoJsonFeature;
export function fromFeature(
  id: number,
  feature: RawFeature,
  header: Header,
  kinds: readonly string[],
): QueryFeature | undefined;
export function fromFeature(
  id: number,
  feature: RawFeature,
  header: Header,
  kinds?: readonly string[],
): GeoJsonFeature | QueryFeature | undefined;

/** Queries use views into the tile for the kinds they ask for; map drawing still requests GeoJSON by omitting kinds. */
export function fromFeature(
  id: number,
  feature: RawFeature,
  header: Header,
  kinds?: readonly string[],
): GeoJsonFeature | QueryFeature | undefined {
  const properties = parseProperties(feature, header.columns);
  if (kinds && !kinds.includes(properties.kind as string)) return;
  const geometry = feature.geometry()!;
  if (!kinds) return { type: "Feature", id, properties, geometry: fromGeometry(geometry, header.geometryType) };
  return {
    type: "Feature" as const,
    id,
    properties: properties as QueryFeature["properties"],
    geometry: { xy: geometry.xyArray()!, ends: geometry.endsArray() },
  };
}
