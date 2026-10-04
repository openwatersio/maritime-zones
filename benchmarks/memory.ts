/** Profile warmed fixes against a built Node package, including garbage collected during the run. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { digest } from "./digest.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "." },
    cache: { type: "string", default: "dist/tiles" },
    case: { type: "string", default: "ijmuiden" },
    fixes: { type: "string", default: "500" },
    profile: { type: "string" },
  },
});
const fixes = Number(values.fixes);
assert.ok(Number.isSafeInteger(fixes) && fixes > 0, "--fixes must be a positive integer");
const positions: Record<string, [number, number]> = { ijmuiden: [52.46, 4.5], "norwegian-sea": [66.2, 8.4] };
const position = positions[values.case!];
assert.ok(position, "--case must be ijmuiden or norwegian-sea");
const api = await import(pathToFileURL(resolve(values.source!, "lib/index.js")).href);
api.configure({ cacheDir: resolve(values.cache!), download: false });
const work = async () => [
  await api.whereAmI(...position),
  await api.distanceToLand(...position),
  await api.nearestTerritory(...position),
];
const checksums = async () => (await work()).map(digest);
const expected = await checksums();
const session = values.profile ? new Session() : undefined;
if (session) {
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const start = performance.now();
for (let i = 0; i < fixes; i++) assert.deepEqual(await checksums(), expected, "Answer changed between fixes");
const elapsedMs = performance.now() - start;
const memory = process.memoryUsage();
let sampledBytes: number | undefined;
if (session) {
  const { profile } = await session.post("HeapProfiler.stopSampling");
  writeFileSync(values.profile!, JSON.stringify(profile) + "\n");
  const size = (node: typeof profile.head): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + size(child), 0);
  sampledBytes = size(profile.head);
  session.disconnect();
}
console.log(
  JSON.stringify(
    {
      case: values.case,
      fixes,
      runtime: process.version,
      checksum: expected,
      msPerFix: elapsedMs / fixes,
      ...memory,
      sampledBytes,
    },
    null,
    2,
  ),
);
