import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TMP = join(ROOT, "tmp");
export const DIST = join(ROOT, "dist");
export const LOCK = join(ROOT, "upstream.lock.json");
export const WFS = "https://geo.vliz.be/geoserver/MarineRegions/wfs";

/** Innermost first; whereAmI returns zones in this order. */
export const LAYERS = [
  { key: "internal", typeName: "eez_internal_waters" },
  { key: "archipelagic", typeName: "eez_archipelagic_waters" },
  { key: "12nm", typeName: "eez_12nm" },
  { key: "24nm", typeName: "eez_24nm" },
  { key: "eez", typeName: "eez" },
  { key: "high_seas", typeName: "high_seas" },
] as { key: string; typeName: string; idField?: string }[];
