/**
 * Download every Marine Regions layer this package builds from the VLIZ WFS
 * into tmp/, and record each layer's upstream title, feature count and content
 * hash in upstream.lock.json. The monthly update workflow opens a PR when the
 * lock changes.
 *
 * Features are fetched one at a time: whole layers at full resolution
 * are hundreds of megabytes and the WFS times out on them.
 *
 *   npm run fetch            # reuse tmp/ cache
 *   npm run fetch -- --fresh # ignore the cache
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LAND, LAYERS, LOCK, TMP, WFS } from "./layers.ts";

const fresh = process.argv.includes("--fresh");
if (fresh) rmSync(TMP, { recursive: true, force: true });
const started = Date.now();
const wfs = { requests: 0, retries: 0, responseBytes: 0, elapsedSeconds: 0 };
// Keep partial load figures when fetching fails.
process.on("exit", (code) => {
  const finished = Date.now();
  mkdirSync(TMP, { recursive: true });
  writeFileSync(
    join(TMP, "fetch-stats.json"),
    JSON.stringify(
      {
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date(finished).toISOString(),
        ok: code === 0,
        elapsedSeconds: (finished - started) / 1000,
        wfs: { ...wfs, elapsedSeconds: wfs.elapsedSeconds || (finished - started) / 1000 },
      },
      null,
      2,
    ) + "\n",
  );
});
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));

async function get(query: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    wfs.requests++;
    if (attempt > 1) wfs.retries++;
    const response = await fetch(`${WFS}?service=WFS&version=2.0.0&${query}`);
    const body = await response.text();
    wfs.responseBytes += Buffer.byteLength(body);
    if (response.ok) return body;
    if (attempt === 3) throw new Error(`WFS ${response.status}: ${query}`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

async function cached(file: string, query: string): Promise<string> {
  const path = join(TMP, file);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, await get(query));
  }
  return readFileSync(path, "utf8");
}

const capabilities = await get("request=GetCapabilities");
const lock: Record<string, { title: string; features: number; sha256: string }> = {};

for (const { typeName, key, idField = "mrgid" } of [...LAYERS, LAND]) {
  const title = capabilities.match(new RegExp(`<Name>MarineRegions:${typeName}</Name><Title>([^<]*)</Title>`))?.[1];
  if (!title) throw new Error(`GetCapabilities has no layer ${typeName}`);

  const list = JSON.parse(
    await cached(
      `${key}-index.json`,
      `request=GetFeature&typeNames=MarineRegions:${typeName}&outputFormat=application/json&propertyName=${idField}`,
    ),
  );
  const ids: string[] = list.features
    // Country territory IDs are not unique; WFS feature IDs preserve every polygon.
    .map((f: { id: string; properties: Record<string, number> }) =>
      key === LAND.key ? f.id : `${idField}=${f.properties[idField]}`,
    )
    .sort();
  const hash = createHash("sha256");
  for (const [i, id] of ids.entries()) {
    const name = id.replace(/[^\w.-]+/g, "_");
    const body = await cached(
      join(key, `${name}.json`),
      `request=GetFeature&typeNames=MarineRegions:${typeName}&outputFormat=application/json&${key === LAND.key ? "resourceID" : "cql_filter"}=${encodeURIComponent(id)}`,
    );
    // Hash the features only: every response carries a fresh timeStamp.
    hash.update(JSON.stringify(JSON.parse(body).features));
    if (i % 25 === 0) console.log(`${key}: ${i + 1}/${ids.length}`);
  }
  lock[key] = { title, features: ids.length, sha256: hash.digest("hex") };
  console.log(`${key}: ${title}, ${ids.length} features`);
}

writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");
console.log(`Wrote ${LOCK}`);
wfs.elapsedSeconds = (Date.now() - started) / 1000;
