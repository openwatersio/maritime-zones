/**
 * Print release notes for the current build: the upstream layers from
 * upstream.lock.json and the tile totals from dist/tiles.json.
 *
 *   node scripts/release-notes.ts > notes.md
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIST, LOCK, ROOT } from "./layers.ts";

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const lock: Record<string, { title: string; features: number }> = JSON.parse(readFileSync(LOCK, "utf8"));
const { tiles }: { tiles: Record<string, { bytes: number }> } = JSON.parse(
  readFileSync(join(DIST, "tiles.json"), "utf8"),
);
const sizes = Object.values(tiles).map((t) => t.bytes);
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`;

console.log(`Maritime zone tiles for @openwaters/maritime-zones ${version}. The package downloads the tiles it needs from this release and checks each against the sha256 in \`tiles.json\`.

${sizes.length} tiles, ${mb(sizes.reduce((a, b) => a + b, 0))} in total. Built from the Marine Regions Maritime Boundaries Geodatabase (Flanders Marine Institute), CC-BY 4.0:

${Object.values(lock)
  .map(({ title, features }) => `- ${title}: ${features} ${features === 1 ? "feature" : "features"}`)
  .join("\n")}

**Not for navigation.** Marine Regions data "is not meant to be used for legal, economical … or navigational purposes" and "has no legal value whatsoever". See NOTICE for the citation of each layer.`);
