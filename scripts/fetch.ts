/**
 * Download every Marine Regions layer this package builds from the VLIZ WFS
 * into tmp/, and record each layer's upstream title, feature count and content
 * hash in upstream.lock.json. The monthly update workflow opens a PR when the
 * lock changes.
 *
 * Features are fetched one mrgid at a time: whole layers at full resolution
 * are hundreds of megabytes and the WFS times out on them.
 *
 *   npm run fetch            # reuse tmp/ cache
 *   npm run fetch -- --fresh # ignore the cache
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LAYERS, LOCK, TMP, WFS } from "./layers.ts";

const fresh = process.argv.includes("--fresh");
if (fresh) rmSync(TMP, { recursive: true, force: true });

async function get(query: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${WFS}?service=WFS&version=2.0.0&${query}`);
    if (response.ok) return response.text();
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

for (const { typeName, key, idField = "mrgid" } of LAYERS) {
  const title = capabilities.match(new RegExp(`<Name>MarineRegions:${typeName}</Name><Title>([^<]*)</Title>`))?.[1];
  if (!title) throw new Error(`GetCapabilities has no layer ${typeName}`);

  const list = JSON.parse(
    await cached(
      `${key}-index.json`,
      `request=GetFeature&typeNames=MarineRegions:${typeName}&outputFormat=application/json&propertyName=${idField}`,
    ),
  );
  const ids: string[] = list.features
    .map((f: { properties: Record<string, number> }) => `${idField}=${f.properties[idField]}`)
    .sort();
  const hash = createHash("sha256");
  for (const [i, id] of ids.entries()) {
    const name = id.replace(/[^\w.-]+/g, "_");
    const body = await cached(
      join(key, `${name}.json`),
      `request=GetFeature&typeNames=MarineRegions:${typeName}&outputFormat=application/json&cql_filter=${encodeURIComponent(id)}`,
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
await import("./fetch-land.ts");
