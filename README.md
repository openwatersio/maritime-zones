# maritime-zones

Offline answers to four questions about a position at sea: which maritime zones am I in, how far is the next territory, how far is territory X, and how far is land. The data is the [Marine Regions](https://www.marineregions.org/) Maritime Boundaries Geodatabase from the Flanders Marine Institute (VLIZ), cut into 10° FlatGeobuf tiles compressed as seekable zstd so a consumer only needs the tiles for the area it sails in.

**Not for navigation.** Marine Regions states that its data "is not meant to be used for legal, economical … or navigational purposes" and "has no legal value whatsoever". Neither do these answers. Every consumer that shows them must say so.

## Status

VLIZ has approved redistribution of the derived tiles and the monthly upstream-check load. Maintainers monitor source updates to avoid distributing deprecated versions. Coastlines use the updated World Countries Geodatabase served as `MarineRegions:worldcountries_esri_2014`, the normal-baseline source identified by Marine Regions, under CC-BY 4.0. The package remains private and is not published to npm. See NOTICE for attribution and licences.

The [coastline source and VLIZ reply guide](CONTRIBUTING.md#coastline-source-and-vliz-reply) records the permission scope, source citation and release procedure. The published `v0.1.0` tiles use OpenStreetMap coastlines under ODbL 1.0; the World Countries build is version `0.2.0` and requires a new tiles release.

## Map demos

Try the [interactive demos](https://openwatersio.github.io/maritime-zones/): move the marker, choose a sample position or enter coordinates to answer all four questions. Each view includes Browser and Node.js code examples and its raw result. The browser reads byte ranges from the published tiles on the same Pages origin.

The main black-water example combines `whereAmI()` and `distanceToLand()` with a caller-supplied Canadian 3 NM distance rule in `demo/regulations.ts`, outside the package API. It checks only this illustrative threshold against the coastline in the selected tile release. Passing it does not authorize discharge: vessel requirements, local restrictions and the regulation's legal definition of shore still need checking. See [Canada's section 96](https://laws-lois.justice.gc.ca/eng/regulations/SOR-2012-69/section-96.html). Other countries and ambiguous territory contexts return unresolved.

## Usage

Use the release's source and metadata directly while the package is private:

```sh
git clone https://github.com/openwatersio/maritime-zones.git
cd maritime-zones
git checkout v0.1.0
npm ci
mkdir -p dist
gh release download v0.1.0 --pattern tiles.json --pattern zones.json --dir dist
```

```ts
import { distanceTo, distanceToLand, nearestTerritory, whereAmI } from "./src/index.ts";

await whereAmI(48.6, -123.2);
// [{ layer: "12nm", iso_ter: "USA", name: "United States 12 NM", … }, { layer: "eez", iso_ter: "USA", … }]

await nearestTerritory(48.6, -123.2);
// { distanceNm: 1.4, bearingDeg: 257, point: [48.59, -123.23], zone: { layer: "internal", iso_ter: "CAN", … } }

await distanceTo(51.1, 1.4, "BEL"); // 38.6 NM to Belgian waters
await distanceToLand(40, -40); // 403.7 NM to the Azores
```

- `whereAmI(lat, lon)` returns every zone containing the point, innermost first: internal waters, archipelagic waters, territorial sea (12 NM), contiguous zone (24 NM), EEZ, high seas. The EEZ includes the territorial sea, so a point off a coast is in both. A point on land, including an island, is in no zone.
- `nearestTerritory(lat, lon)` finds the nearest waters of any territory other than the one you are in. "Waters" means sovereign waters by default (internal, archipelagic and 12 NM), because a country's nearest water is often internal: in Haro Strait, Canada's internal waters are 1.4 NM away while its territorial sea is 60 NM away on the outer coast. Pass `{ layers: ["eez"] }` to measure to another zone instead.
- `distanceTo(lat, lon, iso)` is the distance to one territory's waters by ISO 3166-1 alpha-3 code, and 0 inside them.
- `distanceToLand(lat, lon)` is the distance to the nearest coastline.

Distance results carry `distanceNm`, the initial great-circle `bearingDeg` and the nearest `point`. Searches stop at about 480 NM and return `null` beyond that. Distances use a spherical Earth and agree with ellipsoidal geodesics to within 0.5%.

## Tiles and the cache

The package carries `zones.json` and `tiles.json`, which list every tile with its compressed download size and sha256, but not the tiles themselves. A query works out which 10° tiles its search needs, downloads any that aren't cached from the GitHub release matching the package version, checks each against its sha256, and keeps it in the cache for next time. The cache stores compressed `.fgb.zst` downloads; the reader checks the compressed bytes before caching or decompressing them with Node 24. A tile that fails its check is never used or cached.

To be ready before losing signal, download an area ahead of time. Pass a box or a circle, and add the search radius you care about, because a query near the edge of an area can need tiles beyond it:

```ts
import { configure, download, tilesFor } from "./src/index.ts";

tilesFor({ lat: 48.6, lon: -123.2, radiusNm: 150 }); // [{ tile: "n40w130", bytes: … }, …]
await download({ minLat: 47, minLon: -125, maxLat: 51, maxLon: -122 }); // { tiles: 2, bytes: … }

configure({ download: false }); // never touch the network
```

`configure()` takes:

- `cacheDir`: where tiles are kept. Defaults to `$XDG_CACHE_HOME/openwaters/maritime-zones/v<version>`, or `~/.cache/…` when that variable is unset.
- `baseUrl`: where tiles are downloaded from. Defaults to `https://github.com/openwatersio/maritime-zones/releases/download/v<version>`.
- `download`: `true` by default. With `false`, a query that needs a tile that isn't cached throws.

Queries never answer from partial data. A tile they can't get throws an error that names the tile, with `code` set to `MISSING_TILE` (not cached and downloads are off), `DOWNLOAD_FAILED` or `CHECKSUM`.

## Data

| Layer               | Source                                | Features |
| ------------------- | ------------------------------------- | -------- |
| Internal waters     | Internal Waters v4                    | 113      |
| Archipelagic waters | Archipelagic Waters v4                | 23       |
| Territorial sea     | Territorial Seas (12 NM) v4           | 230      |
| Contiguous zone     | Contiguous Zones (24 NM) v4           | 220      |
| EEZ                 | Exclusive Economic Zones (200 NM) v12 | 285      |
| High seas           | High Seas v2                          | 1        |
| Coastline           | World Countries Geodatabase (2020)    | 294      |

`upstream.lock.json` records each layer's title, feature count and content hash as served by the VLIZ WFS. World Countries is cited as Flanders Marine Institute (2020). World Countries Geodatabase. https://marineinfo.org/doc/dataset/8873. It adapts ESRI World Countries 2014, with source data from DeLorme (2014). The build simplifies rings with Douglas–Peucker at 0.0001° (about 11 m), so boundaries of neighboring zones can open slivers up to that width.

Each tile holds zone polygons subdivided into pieces of at most 256 vertices for point lookups, zone rings as lines for distances, and World Countries rings as land-distance lines. Features are not clipped at tile edges; each one is written to every tile its bounding box touches. `zones.json` holds each zone's attributes once, and tile features refer to it by index. Country rings include inland borders and holes; the dataset is a proxy for normal baselines, not a complete legal-baseline model. The 636 tiles total 142 MB compressed; the median tile is 0.03 MB and the largest is 3.8 MB. The release's `tiles.json` records each compressed download size and SHA-256; [Tile format](docs/tile-format.md) documents the compression measurements.

Coastline features use `zone: -1` so every tile has the same integer field for GDAL filters. That value has no entry in `zones.json`; `distanceToLand()` returns `zone: null`.

## Building

Needs Node 24, GDAL (`ogr2ogr`) with FlatGeobuf support and [t2sz](https://github.com/martinellimarco/t2sz) 1.2.5 (`brew install gdal t2sz` on macOS).

```sh
npm ci
npm run fetch   # maritime boundaries and World Countries from WFS into tmp/, cached; writes upstream.lock.json
npm run build   # tmp/ → dist/zones.json, dist/tiles.json, dist/tiles/*.fgb.zst
npm test        # needs dist/; reads dist/tiles directly, offline
```

To query a local build without downloading, point the cache at it: `configure({ cacheDir: "dist/tiles", download: false })`. `scripts/check.ts` compares answers at random points with the live WFS and with exact distances from GDAL; it does not run in CI. `benchmarks/` times the queries against a previous revision, locally and in CI; see CONTRIBUTING.

A release publishes the compressed tiles as flat release assets (`n40w130.fgb.zst`, …), along with `dist/zones.json`, `dist/tiles.json` and `NOTICE`. The Pages mirror serves the identical files at `https://openwatersio.github.io/maritime-zones/v0.1.0/`; browser range queries must run on that Pages origin. The reader must use the `zones.json` and `tiles.json` from that release, because the hashes in `tiles.json` are what downloaded tiles are checked against.

## Licence

The code is MIT. Maritime zone, boundary and World Countries features are CC-BY 4.0 from the Flanders Marine Institute. World Countries includes ESRI and DeLorme (2014) source data. The published `v0.1.0` release retains its OpenStreetMap attribution and ODbL 1.0 terms. NOTICE has the citation and licence for each layer.
