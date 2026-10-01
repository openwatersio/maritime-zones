# Tile format

Tiles are FlatGeobuf compressed as seekable zstd with 256 KiB frames at level 19: `t2sz -r -s 256K -l 19`. One file serves offline downloads and online bounding-box queries. Settle this format before releasing a version: changing the bytes invalidates its caches and the hashes in `tiles.json`.

## Sizes and hashes

Each entry in `tiles.json` records the size and SHA-256 of the **compressed bytes as downloaded**, including the seek table. The reader checks those bytes before caching or decompressing them. The cache stores the compressed file; memory holds a fresh `Uint8Array` of decompressed FlatGeobuf bytes.

Measurements from the 2026-09-30 build cover all 604 tiles, 742 MB uncompressed. Seekable files were made with `t2sz -r`; plain files with `zstd -19`.

| Format                                  | Total  | Compression ratio |
| --------------------------------------- | ------ | ----------------- |
| Seekable zstd, 32 KiB frames, level 3   | 270 MB | 2.74×             |
| Seekable zstd, 32 KiB frames, level 19  | 223 MB | 3.32×             |
| Seekable zstd, 64 KiB frames, level 19  | 188 MB | 3.95×             |
| Seekable zstd, 256 KiB frames, level 19 | 140 MB | 5.28×             |
| Plain zstd, level 19                    | 106 MB | 6.97×             |

Plain zstd is smaller but cannot serve range queries. A second plain copy would need its own build output, sizes and hashes. Consider it only if consumers routinely download whole oceans over satellite links.

## Range queries

FlatGeobuf 4.5.0 can query a seekable file over HTTP with `deserialize(url, { rect, seekableZstd: true })`, fetching the frames containing the index nodes and features that the box touches. This follows the range-read approach discussed in [flatgeobuf#483](https://github.com/flatgeobuf/flatgeobuf/discussions/483).

Bytes transferred and request counts for `n40w130`, a 3.0 MB raw tile:

| Query                           | Raw tile             | 32 KiB frames       | 64 KiB frames       | 256 KiB frames      |
| ------------------------------- | -------------------- | ------------------- | ------------------- | ------------------- |
| Haro Strait, 0.4°, 245 features | 602 KB, 5 requests   | 227 KB, 24 requests | 225 KB, 15 requests | 243 KB, 7 requests  |
| Salish Sea, 2°, 1,217 features  | 1,625 KB, 5 requests | 536 KB, 56 requests | 472 KB, 31 requests | 429 KB, 11 requests |

The 256 KiB files make the fewest requests among the compressed options, stay within about 10% of the fewest bytes, and transfer 2.5 to 3.8 times less than raw tiles. Every copy returns the same features as the raw tile. Smaller frames cost many more requests for little or no saving in bytes.

## Offline reads

A seekable file contains ordinary zstd frames followed by a skippable seek table. Node 24's built-in `zlib.zstdDecompressSync` reads the whole file in one call and returns bytes identical to the raw tile. The offline reader uses `deserialize(bytes, { rect })` without an additional decompression dependency.

## Hosting

GitHub release assets answer range requests with HTTP 206 but do not send `Access-Control-Allow-Origin` on the redirect or asset host. Node and GDAL can read them; browsers need a host with CORS headers. GitHub Pages returns 206 with `Access-Control-Allow-Origin: *`, and 140 MB fits within its 1 GB site limit.

The release and Pages mirror carry identical compressed files under the same SHA-256. `download()` defaults to releases, which have no bandwidth limit; Pages serves browser range reads and has a soft limit of 100 GB per month. `download()` can use either host through `baseUrl`, and a cached compressed tile can also be served locally for range reads.

For `n40w130`, the seekable download is 568 KB against 426 KB for plain zstd. Both are under 1 MB for a typical cruising area, usually downloaded on dock Wi-Fi. Maintaining one format avoids a second set of files and metadata for that saving.

Measurements and the format decision are recorded in [issue #6](https://github.com/openwatersio/maritime-zones/issues/6).
