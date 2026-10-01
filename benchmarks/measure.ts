/**
 * One warmed timing sample of one workload, in one process, printed as JSON.
 * run.ts spawns this for the base and the candidate in turn so their samples
 * interleave. Usage: node benchmarks/measure.ts <source-root> offline|range <workload> [iterations]
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { digest } from "./digest.ts";
import { serveRanges } from "./range-server.ts";

console.debug = () => {}; // flatgeobuf logs every index node it visits

const [source, mode, name, fixed] = process.argv.slice(2);
assert.ok(
  source && (mode === "offline" || mode === "range") && name,
  "Usage: node benchmarks/measure.ts <source-root> offline|range <workload> [iterations]",
);
const cacheDir = process.env.MARITIME_ZONES_CACHE;
assert.ok(cacheDir, "MARITIME_ZONES_CACHE must name a directory of cached tiles");
const suite = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
const spec = suite.cases.find((c: { name: string }) => c.name === name);
assert.ok(spec, `Unknown workload: ${name}`);
const iterations = fixed === undefined ? undefined : Number(fixed);
assert.ok(iterations === undefined || (Number.isSafeInteger(iterations) && iterations > 0), "Invalid iteration count");

const load = (file: string) => import(pathToFileURL(join(source, file)).href);
const counters = { requests: 0, bytes: 0 };
let api: any;
let server: Awaited<ReturnType<typeof serveRanges>> | undefined;
if (mode === "offline") {
  api = await load("src/index.ts");
  api.configure({ cacheDir, download: false });
} else {
  // The browser path: the shared query math over HTTP range reads of the compressed tiles.
  const { createQueries } = await load("src/queries.ts");
  const { deserialize } = await import("flatgeobuf/lib/mjs/geojson.js");
  const index = JSON.parse(readFileSync(join(source, "dist/tiles.json"), "utf8")).tiles;
  const zones = JSON.parse(readFileSync(join(source, "dist/zones.json"), "utf8"));
  server = await serveRanges(cacheDir);
  const base = server.url;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    counters.requests++;
    counters.bytes += Number(response.headers.get("content-length") ?? 0);
    return response;
  };
  api = createQueries(
    (tile: string, rect: unknown) => deserialize(`${base}${tile}.fgb.zst`, { rect, seekableZstd: true } as any),
    () => index,
    () => zones,
  );
}

const { lat, lon, iso } = spec;
const work: () => Promise<any> = {
  whereAmI: () => api.whereAmI(lat, lon),
  nearestTerritory: () => api.nearestTerritory(lat, lon),
  distanceTo: () => api.distanceTo(lat, lon, iso),
  distanceToLand: () => api.distanceToLand(lat, lon),
}[spec.query as string]!;
assert.ok(work, `Unknown query: ${spec.query}`);
// Consumes each timed answer without hashing it inside the measurement.
const sink = (answer: any) => (Array.isArray(answer) ? answer.length : answer ? answer.distanceNm : -1);

// The first call also pays for loading tiles; its requests and bytes are what one browser query costs.
const first = await work();
const checksum = digest(first);
const expected = sink(first);
const { requests, bytes } = counters;

const batch = async (n: number) => {
  let sum = 0;
  const start = performance.now();
  for (let i = 0; i < n; i++) sum += sink(await work());
  const elapsed = performance.now() - start;
  assert.ok(Math.abs(sum / n - expected) <= Math.max(1, Math.abs(expected)) * 1e-9, `${name}: output changed`);
  return elapsed;
};
const warmup = performance.now();
do await batch(1);
while (performance.now() - warmup < suite.warmupMs);
let n = iterations ?? 1;
if (iterations === undefined) while ((await batch(n)) < suite.sampleMs) n *= 2;
const sample = (await batch(n)) / n;
assert.equal(digest(await work()), checksum, `${name}: output changed during measurement`);
await server?.close();
console.log(
  JSON.stringify({ name, mode, iterations: n, checksum, samplesMs: [sample], ...(server && { requests, bytes }) }),
);
