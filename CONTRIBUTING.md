# Contributing

## Layout

- `scripts/fetch.ts` downloads every layer from the VLIZ WFS into `tmp/`, one feature per request, and writes `upstream.lock.json`. `scripts/fetch-land.ts` downloads the ODbL OpenStreetMap coastline archive, records its hash in the same lock and streams its lines through GDAL.
- `scripts/build.ts` turns `tmp/` into `dist/zones.json`, `dist/tiles.json` and `dist/tiles/*.fgb.zst` (with raw `.fgb` intermediates for the GDAL distance oracle).
- `scripts/layers.ts` lists the upstream layers and paths shared by the scripts.
- `scripts/check.ts` compares answers at random points with the live WFS and with exact GDAL distances.
- `scripts/bench.ts` prints answers at fixed points and times each query.
- `scripts/release-notes.ts` prints the release notes for the current build.
- `scripts/update-notes.ts` prints the monthly check's WFS load and source changes.
- `src/` is the reader: `index.ts` has the queries, `store.ts` finds tiles in memory, the cache or the GitHub release and checks them, and `tiles.ts` maps areas to tile names.
- `test/` holds vitest cases. `queries.test.ts` checks answers at fixed points. `store.test.ts` checks downloading and caching against a local server that serves `dist/tiles` the way a release serves assets. Both read `dist/`.

`tmp/` and `dist/` are not committed.

## Getting started

Needs Node 24 (see `mise.toml`), GDAL with FlatGeobuf support for `ogr2ogr`, curl and [t2sz](https://github.com/martinellimarco/t2sz) 1.2.5. On macOS: `brew install gdal t2sz`.

```sh
npm ci
npm run fetch   # about 1,000 requests and 30 minutes the first time; cached in tmp/ after that
npm run build   # about 4 minutes
npm test
```

`npm run fetch -- --fresh` ignores the cache.

## Checks

CI runs:

```sh
npm ci
npm run lint
npx tsc -p .
```

CI does not run the vitest suite, because the tests need `dist/`, and building it downloads every layer from VLIZ. Run `npm test` locally after `npm run build`. Before changing query or build logic, also run `node scripts/check.ts`, which should report 0 zone mismatches and distance errors under 1%.

## Monthly upstream check

The **Check upstream data** workflow runs from the default branch on the first of each month at 07:17 UTC. GitHub may delay scheduled runs. To measure a run sooner, select **Run workflow** in its Actions page or run `gh workflow run updates.yml`.

Each run fetches the six Marine Regions layers serially with `npm run fetch -- --fresh`, then downloads and converts the OSM coastline archive. It compares `upstream.lock.json` with the committed version. Changed data is built and tested before the workflow opens or updates a single PR on `update-upstream`. The PR lists each changed layer's old and new title, feature count and hash. Unchanged data creates no PR. If an outstanding update reverts to the committed data, its PR is closed. No release, Pages deployment or npm publication occurs.

The run summary and the `upstream-load` artifact retain the load report for 90 days, including partial figures on fetch failure. `tmp/fetch-stats.json` records start/end times, success, elapsed time, actual WFS request attempts, retries and response bytes. Cache hits make no WFS requests. Response bytes count UTF-8 response bodies after HTTP decompression, including HTTP error responses; they do not measure wire traffic or server CPU. WFS time includes retry waits; full-fetch time also includes the OSM download and GDAL conversion. OSM traffic is separate from the WFS counters.

With the current lock, a fresh check needs 879 WFS requests before retries: one capabilities request, six feature indexes and 872 individual features. The artifact records the actual count if upstream changes or retries occur. The WFS hashes ignore response timestamps, so an unchanged source does not produce an update just because it was fetched again. The OSM archive is hashed separately and is about 925 MB.

Monthly checks are enabled at the maintainer's request while VLIZ's preference is pending in [issue #11](https://github.com/openwatersio/maritime-zones/issues/11). Share the run's report when discussing load. If VLIZ asks for less frequent fetching or a capabilities-first check, change the schedule or fetch strategy in a PR. If they ask us to stop, remove the schedule and avoid manual fetches until resolved. The v9 workaround below remains in force.

## Coastline source and VLIZ reply

Permission to use Marine Regions `land_v9` and its licence are unconfirmed, so coastlines come from OpenStreetMap under ODbL 1.0. `land_v9` is excluded from `scripts/layers.ts`; fetching and building ignore any cached `tmp/land/` files. `scripts/fetch-land.ts` downloads OSM's WGS84 coastline lines, and `scripts/build.ts` writes them as `kind: "land"` features for `distanceToLand()`. The six maritime-zone and boundary layers still come from Marine Regions. [Issue #11](https://github.com/openwatersio/maritime-zones/issues/11) tracks the questions sent to VLIZ.

VLIZ's reply needs to answer two separate questions: whether we may use `land_v9`, with its applicable licence and attribution, and whether derived tiles may be offered for download through GitHub releases and Pages. Confirmation about the maritime-boundary layers alone does not settle `land_v9`.

If redistribution is approved but v9 usage remains unclear or is declined, keep OSM coastlines and update the experimental status to reflect the reply's scope and conditions. If redistribution is declined, take down the release and Pages mirror using the commands below and distribute code for consumers to build locally. If both v9 usage and derived-tile redistribution are explicitly approved, restore v9 through a source-change PR:

1. Record the reply and its scope in issue #11, including the confirmed v9 licence and attribution requirements.
2. Add `{ key: "land", typeName: "land_v9", idField: "id" }` to `scripts/layers.ts` and remove the OSM fetch import from `scripts/fetch.ts`. In `scripts/build.ts`, replace the OSM line stream with the v9 polygon-ring path: simplify and chunk every ring into `kind: "land", zone: -1` lines, and keep land out of `zones.json`. Preserve seekable zstd compression, compressed-byte hashes and the reader's `zone: null` land results.
3. Fetch fresh source data and commit the new `upstream.lock.json`. Replace the OSM-only build regression with a v9 polygon fixture. Update NOTICE, README, these source instructions, release notes and workflow source labels to match the confirmed terms. OSM attribution remains part of releases containing OSM data.
4. Rebuild, run `npm test` and `node scripts/check.ts`, and require 0 zone mismatches and distance errors under 1%. Review the new tile counts, sizes and hashes.
5. Bump the package version and publish a new tiles release and Pages mirror. Verify the fresh-cache Belgian query and Pages range reads against that release's metadata. Keep `v0.1.0` and its OSM assets unchanged: changing coastlines changes hashes, and caches are separated by version. The package stays `private: true`; npm publication needs a separate decision.

## Releases

See [Tile format](docs/tile-format.md) for the seekable zstd format, compression measurements, range reads and what the download hashes cover.

Tiles ship as flat assets on the GitHub release `v<version>`, where `<version>` is the one in `package.json`: every `dist/tiles/*.fgb.zst` plus `dist/zones.json`, `dist/tiles.json` and `NOTICE`. Raw `.fgb` intermediates stay local for the GDAL distance oracle. The reader downloads tiles from the release matching its own version and checks them against the hashes in its packaged `tiles.json`, so a release is never replaced. New tiles need a new version.

To release:

1. If either source has changed, run `npm run fetch -- --fresh` and commit the new `upstream.lock.json` in a pull request. The release workflow refuses to publish data that differs from the committed lock.
2. Bump `version` in `package.json` in a pull request.
3. Run the **Release tiles** workflow from the Actions tab. It fetches the maritime boundaries from VLIZ (about 30 minutes) and the OSM coastlines (about 925 MB), builds and compresses the tiles, runs the tests against them and writes the release notes to the run summary. With `dry_run` left on, the default, that's all it does. With `dry_run` off, it creates a draft release, uploads every compressed tile plus both metadata files and NOTICE, checks the count, publishes, verifies a query from an empty cache and deploys the identical files to Pages.

Uploads are spaced eight seconds apart to stay below [GitHub's content-creation limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), so uploading a full global build takes about 80 minutes. Rate limits honor GitHub's retry delay, with bounded backoff. If a run stops with a draft, rerun the workflow: it checks every existing asset's hash and uploads only missing files. If those hashes differ, delete the draft and start again. Published releases cannot be resumed or replaced.

The npm package must carry the `zones.json` and `tiles.json` from the release it points at; take them from the release rather than rebuilding.

The package remains `private: true` and is not published to npm. Marine Regions asks that its products not be offered for download elsewhere; confirmation of derived-tile redistribution is pending with VLIZ. Releases are experimental and may be removed if VLIZ declines. The coastline comes from OpenStreetMap under ODbL 1.0; `land_v9` is not fetched or built.

Enable GitHub Pages with GitHub Actions as its source before publishing. The mirror serves the latest release at `https://openwatersio.github.io/maritime-zones/v<version>/`, with the same filenames and SHA-256 as the release. Set `baseUrl` to that URL for whole-tile downloads. For browser range queries, host the demo on the same Pages origin and use FlatGeobuf with `seekableZstd: true`; Pages does not expose the `Content-Range` header to other origins. See [Tile format](docs/tile-format.md).

To take down the experimental data, delete the release (`gh release delete v0.1.0 --yes --cleanup-tag`) and the Pages site (`gh api --method DELETE repos/openwatersio/maritime-zones/pages`). Keep the workflow in dry-run mode. Copies consumers have already downloaded remain in their caches.

Publishing to npm would also need a JavaScript build, because Node does not strip TypeScript types inside `node_modules`.

## Gotchas

- flatgeobuf's in-memory reader returns wrong features, or throws `Invalid header size`, when given a Node `Buffer` or a `Uint8Array` with a `byteOffset`. The reader copies each tile into a fresh `Uint8Array`. See [flatgeobuf#526](https://github.com/flatgeobuf/flatgeobuf/issues/526).
- flatgeobuf's `packedrtree` calls `console.debug` for every index node it visits, and there is no option to turn it off. Silence `console.debug` in scripts, or the output buries everything else.
- The flatgeobuf npm writer does not build a spatial index, so tiles are written with GDAL.
- The GDAL FlatGeobuf driver cannot overwrite a layer. Delete the output file before running `ogr2ogr`.
- Every WFS response carries a fresh `timeStamp`, so `upstream.lock.json` hashes only the features. Hashing the raw response would change the lock on every fetch.
- Scripts and tests that read a local build call `configure({ cacheDir: "dist/tiles", download: false })`. Without it the reader looks in the user cache and tries to download from a release that may not exist.
- A point on an island is in no zone: islands are holes in every zone polygon. An empty `whereAmI` on land is correct.
