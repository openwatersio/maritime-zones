import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { LOCK, TMP } from "./layers.ts";

const source = "https://osmdata.openstreetmap.de/download/coastlines-split-4326.zip";
const archive = join(TMP, "coastlines.zip");
const coastlines = join(TMP, "coastlines.geojsonl");
mkdirSync(TMP, { recursive: true });
if (!existsSync(archive)) {
  console.log(`Downloading OSM coastlines from ${source}`);
  execFileSync("curl", ["-fL", "--retry", "3", source, "-o", `${archive}.partial`], { stdio: "inherit" });
  renameSync(`${archive}.partial`, archive);
}
if (!existsSync(coastlines)) {
  rmSync(`${coastlines}.partial`, { force: true });
  // Coastline lines avoid the artificial boundaries of split land polygons.
  execFileSync(
    "ogr2ogr",
    [
      "-f",
      "GeoJSONSeq",
      "-lco",
      "RS=NO",
      "-nlt",
      "LINESTRING",
      "-select",
      "",
      `${coastlines}.partial`,
      `/vsizip/${archive}/coastlines-split-4326/lines.shp`,
    ],
    { stdio: "inherit" },
  );
  renameSync(`${coastlines}.partial`, coastlines);
}
const hash = createHash("sha256");
for await (const bytes of createReadStream(archive)) hash.update(bytes);
let features = 0;
for await (const line of createInterface({ input: createReadStream(coastlines), crlfDelay: Infinity })) {
  if (line) features++;
}
const lock = JSON.parse(readFileSync(LOCK, "utf8"));
lock.land = { title: "OpenStreetMap coastlines (WGS84), ODbL 1.0", source, features, sha256: hash.digest("hex") };
writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");
console.log(`land: ${features} OSM coastline lines`);
