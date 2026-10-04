# maritime-zones

Offline answers about a position at sea: which maritime zones am I in, how far is the next territory, how far is territory X, how far is land, and where does my course cross those waters. The data is the [Marine Regions](https://www.marineregions.org/) Maritime Boundaries Geodatabase from the Flanders Marine Institute (VLIZ), cut into 10° FlatGeobuf tiles compressed as seekable zstd so a consumer only needs the tiles for the area it sails in.

**Not for navigation.** Marine Regions states that its data "is not meant to be used for legal, economical … or navigational purposes" and "has no legal value whatsoever". Neither do these answers. Every consumer that shows them must say so.

## Status

VLIZ has approved redistribution of the derived tiles and the monthly upstream-check load. Maintainers monitor source updates to avoid distributing deprecated versions. Coastlines use the updated World Countries Geodatabase served as `MarineRegions:worldcountries_esri_2014`, the normal-baseline source identified by Marine Regions, under CC-BY 4.0. The reader is published to npm as `@openwaters/maritime-zones`. See NOTICE for attribution and licences.

The [coastline source and VLIZ reply guide](CONTRIBUTING.md#coastline-source-and-vliz-reply) records the permission scope, source citation and release procedure. Releases from `v0.2.0` use World Countries coastlines; `v0.1.0` uses OpenStreetMap coastlines under ODbL 1.0.

## Map demos

Try the [interactive demos](https://openwatersio.github.io/maritime-zones/): move the marker, choose a sample position or enter coordinates to answer all four questions. Each view includes Browser and Node.js code examples and its raw result. The browser reads byte ranges from the published tiles on the same Pages origin.

The main black-water example combines `whereAmI()` and `distanceToLand()` with a caller-supplied Canadian 3 NM distance rule in `demo/regulations.ts`, outside the package API. It checks only this illustrative threshold against the coastline in the selected tile release. Passing it does not authorize discharge: vessel requirements, local restrictions and the regulation's legal definition of shore still need checking. See [Canada's section 96](https://laws-lois.justice.gc.ca/eng/regulations/SOR-2012-69/section-96.html). Other countries and ambiguous territory contexts return unresolved.

## Usage

Needs Node 24 or newer.

```sh
npm install @openwaters/maritime-zones
```

```ts
import { distanceTo, distanceToLand, nearestTerritory, whereAmI } from "@openwaters/maritime-zones";

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

### Waters ahead

`ahead(lat, lon, cogDeg, options)` follows a constant course over ground in degrees true along a spherical rhumb line. It returns the selected zones at the start and their territory transitions, ordered by along-course distance:

```ts
import { ahead } from "@openwaters/maritime-zones";

await ahead(52.2, 4.2, 225, { maxNm: 120 });
// {
//   start: [{ layer: "12nm", iso_ter: "NLD", … }],
//   onLand: false,
//   crossings: [
//     { kind: "water", distanceNm: 56.68, point: [51.53, 3.12],
//       leaving: [{ iso_ter: "NLD", … }], entering: [{ iso_ter: "BEL", … }] },
//     { kind: "water", distanceNm: 89.58, point: [51.15, 2.50],
//       leaving: [{ iso_ter: "BEL", … }], entering: [{ iso_ter: "FRA", … }] },
//     { kind: "coast", distanceNm: 97.79, point: [51.05, 2.34] }
//   ]
// }
```

`layers` defaults to sovereign waters (`internal`, `archipelagic`, `12nm`). `maxNm` defaults to 480 NM and must be positive and at most 480. A direct border crossing can leave and enter territories at the same point. Same-territory layer changes and water tangencies produce no event. Full `Zone` records preserve overlapping claims and joint regimes, including their second and third parties. For a joint zone, an `entering` record can include a party already present when another party is added. Zones without territory codes still report transitions between their zone identities. The package exports `AheadOptions`, `AheadResult`, and the discriminated `Crossing` type.

Candidate boundaries within 1 metre of the earliest candidate are grouped into one crossing, using that candidate's distance. Larger gaps and overlaps stay separate. The coastline event uses the actual coastline-contact distance and ends the result. It includes tangencies, has no country identity, and does not establish entry onto land. Water polygons and the coastline can disagree: one Belgian approach has a roughly 405 m interval between its territorial-water exit and coastline contact.

A start in no zone of any layer sets `onLand`: the position is on land, or in a harbour or berth the coastline covers. Leaving land there is not a coastline contact, so the result continues with the waters beyond; only a contact from water ends it. A course exactly along a boundary has no unique crossing. Coordinates and course must be finite, latitude must be strictly between −90° and 90°, and longitude must be between −180° and 180°. A horizon that reaches a pole or spans more than 16 longitude revolutions throws `RangeError`; shorten `maxNm` for extreme polar courses. An empty `crossings` array means no transition or coastline contact was found within the horizon; missing tiles still throw.

The caller calculates ETA with `crossing.distanceNm / sogKn * 60` for positive speed over ground in knots. Speed changes can reuse the crossings for the same starting position, course, and horizon.

## Tiles and the cache

The package carries `zones.json` and `tiles.json`, which list every tile with its compressed download size and sha256, but not the tiles themselves. A query works out which 10° tiles its search needs, downloads any that aren't cached from the GitHub release selected by `tileVersion` in `package.json`, checks each against its sha256, and keeps it in the cache for next time. Reader versions can share the same tile release and cache. The cache stores compressed `.fgb.zst` downloads; the reader checks the compressed bytes before caching or decompressing them with Node 24. A tile that fails its check is never used or cached.

To be ready before losing signal, download an area ahead of time. Pass a box or a circle, and add the search radius you care about, because a query near the edge of an area can need tiles beyond it:

```ts
import { configure, download, tilesFor } from "@openwaters/maritime-zones";

tilesFor({ lat: 48.6, lon: -123.2, radiusNm: 150 }); // [{ tile: "n40w130", bytes: … }, …]
await download({ minLat: 47, minLon: -125, maxLat: 51, maxLon: -122 }); // { tiles: 2, bytes: … }

configure({ download: false }); // never touch the network
```

A cruising area needs a few megabytes. These are the `v0.2.0` download sizes that `tilesFor()` reports for some sample areas:

| Area                              | Tiles |    MB |
| --------------------------------- | ----: | ----: |
| Amsterdam, 25 NM around           |     1 |  1.00 |
| Amsterdam, 150 NM around          |     2 |  1.73 |
| Dutch and Belgian coast           |     1 |  1.00 |
| Salish Sea                        |     2 |  1.28 |
| English Channel                   |     4 |  5.77 |
| Western Mediterranean             |     6 |  4.01 |
| Caribbean                         |    12 |  5.47 |
| Norwegian coast to the North Cape |    12 | 14.24 |
| Indonesia                         |    18 | 17.20 |
| The whole world                   |   636 |   142 |

The cost follows the 10° grid, not the area's size. An area inside one tile costs that tile, and a small area that straddles a tile line costs two. Tiles with dense, intricate coastlines are the largest, such as Norway's fjords and the Indonesian archipelago. For comparison, the raw Marine Regions zone layers this package is built from are about 680 MB of GeoJSON.

`configure()` takes:

- `cacheDir`: where tiles are kept. Defaults to `$XDG_CACHE_HOME/openwaters/maritime-zones/v<tileVersion>`, or `~/.cache/…` when that variable is unset.
- `baseUrl`: where tiles are downloaded from. Defaults to `https://github.com/openwatersio/maritime-zones/releases/download/v<tileVersion>`.
- `download`: `true` by default. With `false`, a query that needs a tile that isn't cached throws.

Queries never answer from partial data. A tile they can't get throws an error that names the tile, with `code` set to `MISSING_TILE` (not cached and downloads are off), `DOWNLOAD_FAILED` or `CHECKSUM`.

## Performance

Median milliseconds per call on a four-core GitHub Actions runner (AMD EPYC 9V74, Ubuntu x64, Node 24.21.0) with reader 0.3.0 and the `v0.2.0` tiles, measured on 2026-10-04. The [CI run](https://github.com/openwatersio/maritime-zones/actions/runs/37219322555) passed all 26 comparisons and measured the 8 course workloads; its `performance` artifact contains the raw samples and machine metadata. [PR #29](https://github.com/openwatersio/maritime-zones/pull/29) and [PR #31](https://github.com/openwatersio/maritime-zones/pull/31) record the before-and-after comparisons. Offline is the Node API over cached tiles. Range is the browser path: HTTP range reads of the compressed tiles from a local server, with the requests and bytes one call makes. On GitHub Pages each request also pays network latency. Timings depend on the machine and its load; requests and bytes are exact.

| Workload                            | Offline ms | Range ms | Requests |    MB |
| ----------------------------------- | ---------: | -------: | -------: | ----: |
| whereAmI/off-ostend                 |       0.05 |      4.3 |        5 |  0.20 |
| whereAmI/haro-strait                |       0.11 |      6.4 |        7 |  0.27 |
| whereAmI/taveuni                    |       0.08 |      6.0 |        8 |  0.22 |
| nearestTerritory/dover              |       0.24 |     11.8 |       14 |  0.53 |
| nearestTerritory/haro-strait        |       1.09 |     16.9 |       15 |  0.57 |
| nearestTerritory/taveuni            |       7.08 |     88.1 |       71 |  2.18 |
| nearestTerritory/mid-north-atlantic |       0.80 |     47.5 |       98 |  0.69 |
| nearestTerritory/norwegian-sea      |     303.12 |   1333.5 |      343 | 14.75 |
| nearestTerritory/labrador-sea       |     142.55 |    685.6 |      174 |  7.35 |
| distanceTo/dover-bel                |       1.58 |     43.4 |       43 |  1.80 |
| distanceToLand/haro-strait          |       1.03 |     11.8 |        8 |  0.31 |
| distanceToLand/mid-north-atlantic   |       0.74 |     40.0 |       86 |  0.63 |
| distanceToLand/norwegian-sea        |      51.24 |    290.5 |       97 |  4.44 |
| ahead/north-sea-belgium             |       0.46 |     19.0 |       22 |  0.94 |
| ahead/dutch-coast                   |       2.43 |     30.1 |       28 |  1.16 |
| ahead/fiji-antimeridian             |       0.83 |     21.8 |       27 |  0.81 |
| ahead/atlantic-empty                |       0.17 |     15.2 |       30 |  0.21 |

A query far from any other territory is slow because its search box grows until it holds the answer, up to 480 NM; the search uses the first matching feature's distance to bound its next pass. A course reads each tile it crosses once, so `ahead/atlantic-empty` covers 480 NM of open water in 30 requests. Readers filter each feature's kind before yielding it to the query, then measure containment and distance directly from FlatBuffers coordinate views. Queries do not build GeoJSON coordinate arrays; the map decoder still does when drawing zone pieces. All feature kinds share a tile index, so filtering saves processing but does not reduce range requests or bytes. CI benchmarks every change to the queries; [CONTRIBUTING](CONTRIBUTING.md#performance) explains how to run the harness.

Memory after 500 warmed fixes at each position, calling `whereAmI()`, `distanceToLand()` and `nearestTerritory()` with the built reader 0.2.2 and the `v0.2.0` tiles. These separate-process measurements were taken on 2026-10-04 on an Apple M1 Ultra (macOS arm64, Node 26.10.0), separately from the CI timings above. MB is decimal.

| Position      | Resident MB | JS heap used MB | Array buffers MB |
| ------------- | ----------: | --------------: | ---------------: |
| IJmuiden      |         120 |              22 |                7 |
| Norwegian Sea |         257 |              29 |               77 |

Resident memory includes retained tiles, live objects and V8's garbage-collection headroom. Array buffers include both retained tiles and temporary reader buffers. The [memory harness](CONTRIBUTING.md#performance) reports these counters and can sample allocations collected during queries. Node version, platform and workload affect these figures; no Raspberry Pi was measured.

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
