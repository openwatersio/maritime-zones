# maritime-zones

Offline answers to four questions about a position at sea: which maritime zones am I in, how far is the next territory, how far is territory X, and how far is land. The data is the [Marine Regions](https://www.marineregions.org/) Maritime Boundaries Geodatabase from the Flanders Marine Institute (VLIZ), cut into 10° FlatGeobuf tiles so a consumer only needs the tiles for the area it sails in.

**Not for navigation.** Marine Regions states that its data "is not meant to be used for legal, economical … or navigational purposes" and "has no legal value whatsoever". Neither do these answers. Every consumer that shows them must say so.

## Status

Not published. Marine Regions asks that its products not be offered for download elsewhere; publishing the tiles is on hold until VLIZ answers whether derived tiles are acceptable. The licence of the `land_v9` coastline is being confirmed too. See NOTICE.

## Usage

```ts
import { configure, distanceTo, distanceToLand, nearestTerritory, whereAmI } from "@openwaters/maritime-zones";

configure({ dir: "/path/to/data" }); // zones.json, tiles.json and tiles/*.fgb

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

A query reads every tile under its search box. If one of those tiles is listed in `tiles.json` but missing from disk, the query throws an error with `code: "MISSING_TILE"` and the tile's name rather than return a short answer. Use `tiles([minLon, minLat, maxLon, maxLat])` to list the tiles an area needs, adding the search radius you care about.

## Data

| Layer               | Source                                | Features |
| ------------------- | ------------------------------------- | -------- |
| Internal waters     | Internal Waters v4                    | 113      |
| Archipelagic waters | Archipelagic Waters v4                | 23       |
| Territorial sea     | Territorial Seas (12 NM) v4           | 230      |
| Contiguous zone     | Contiguous Zones (24 NM) v4           | 220      |
| EEZ                 | Exclusive Economic Zones (200 NM) v12 | 285      |
| High seas           | High Seas v2                          | 1        |
| Coastline           | land_v9                               | 3        |

`upstream.lock.json` records each layer's title, feature count and content hash as served by the VLIZ WFS. The build simplifies rings with Douglas–Peucker at 0.0001° (about 11 m), so boundaries of neighboring zones can open slivers up to that width.

Each tile holds zone polygons subdivided into pieces of at most 256 vertices for point lookups, zone rings as lines for distances, and coastline rings as lines. Features are not clipped at tile edges; each one is written to every tile its bounding box touches. `zones.json` holds each zone's attributes once, and tile features refer to it by index. The 604 tiles total 742 MB; the median tile is 0.11 MB and the largest, over French Polynesia, is 23 MB.

## Building

Needs Node 24 and GDAL (`ogr2ogr`) with FlatGeobuf support.

```sh
npm ci
npm run fetch   # about 1,000 WFS requests into tmp/, cached; writes upstream.lock.json
npm run build   # tmp/ → dist/zones.json, dist/tiles.json, dist/tiles/*.fgb
npm test        # needs dist/
```

`scripts/check.ts` compares answers at random points with the live WFS and with exact distances from GDAL, and `scripts/bench.ts` times the queries. Neither runs in CI.

The reader copies each tile into a fresh `Uint8Array` before handing it to flatgeobuf, whose in-memory reader assumes it owns its whole `ArrayBuffer` from byte 0. A Node `Buffer` from `readFileSync` breaks that assumption and gives wrong features or a crash.

## Licence

The code is MIT. The data is CC-BY 4.0 from the Flanders Marine Institute; NOTICE has the citation for each layer.
