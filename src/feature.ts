import { parseProperties } from "flatgeobuf/lib/mjs/generic/feature.js";
import { fromGeometry } from "flatgeobuf/lib/mjs/geojson/geometry.js";
import type { fromFeature as decodeFeature } from "flatgeobuf/lib/mjs/geojson/feature.js";

/** Reject other kinds before allocating coordinate arrays or yielding to the query. */
export function fromFeature(
  id: number,
  feature: Parameters<typeof decodeFeature>[1],
  header: Parameters<typeof decodeFeature>[2],
  kind?: string,
): ReturnType<typeof decodeFeature> | undefined {
  const properties = parseProperties(feature, header.columns);
  if (kind && properties.kind !== kind) return;
  return { type: "Feature" as const, id, properties, geometry: fromGeometry(feature.geometry()!, header.geometryType) };
}
