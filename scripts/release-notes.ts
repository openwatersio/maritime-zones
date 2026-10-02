/**
 * Print release notes for the current build: the upstream layers from
 * upstream.lock.json and the tile totals from dist/tiles.json.
 *
 *   node scripts/release-notes.ts > notes.md
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIST, LOCK, ROOT } from "./layers.ts";

const { tileVersion } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const lock: Record<string, { title: string; features: number }> = JSON.parse(readFileSync(LOCK, "utf8"));
const { tiles }: { tiles: Record<string, { bytes: number }> } = JSON.parse(
  readFileSync(join(DIST, "tiles.json"), "utf8"),
);
const sizes = Object.values(tiles).map((t) => t.bytes);
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`;

console.log(`Maritime zone tiles v${tileVersion}. Readers with tileVersion ${tileVersion} download the tiles they need from this release and check each against the sha256 in \`tiles.json\`.

${sizes.length} seekable zstd tiles (256 KiB frames, level 19), ${mb(sizes.reduce((a, b) => a + b, 0))} in total. Sizes and SHA-256 cover the compressed downloads.

Zone and boundary features: Marine Regions Maritime Boundaries Geodatabase (Flanders Marine Institute), CC-BY 4.0. Land features: Flanders Marine Institute (2020). [World Countries Geodatabase](https://marineinfo.org/doc/dataset/8873), CC-BY 4.0, adapted from ESRI World Countries 2014 with DeLorme (2014) source data. Country polygon rings come from MarineRegions:worldcountries_esri_2014 and include inland borders and holes. The source hashes are recorded in upstream.lock.json. Marine Regions land_v9 is not used.

VLIZ has approved derived-tile redistribution and the monthly upstream-check load. Maintainers monitor Marine Regions updates to avoid distributing deprecated versions. World Countries supplies a proxy for normal baselines, not a complete legal-baseline model. The v0.1.0 release uses OpenStreetMap coastlines and retains its own NOTICE and ODbL 1.0 terms. npm publication is authorized and follows the matching tile release; see CONTRIBUTING.md for publishing instructions.

${Object.values(lock)
  .map(({ title, features }) => `- ${title}: ${features} ${features === 1 ? "feature" : "features"}`)
  .join("\n")}

**Not for navigation.** Marine Regions data "is not meant to be used for legal, economical … or navigational purposes" and "has no legal value whatsoever". See the attached NOTICE for the citation and licence of each layer.`);
