# Contributing

## Layout

- `scripts/fetch.ts` downloads the maritime-zone layers and World Countries from the VLIZ WFS into `tmp/`, one feature per request, and writes `upstream.lock.json`. Zone features use their MRGIDs; country features use WFS feature IDs because territory IDs can be shared.
- `scripts/build.ts` turns `tmp/` into `dist/zones.json`, `dist/tiles.json` and `dist/tiles/*.fgb.zst` (with raw `.fgb` intermediates for the GDAL distance oracle).
- `scripts/layers.ts` lists the upstream layers and paths shared by the scripts.
- `scripts/check.ts` compares answers at random points with the live WFS and with exact GDAL distances.
- `benchmarks/` times the queries offline and over HTTP range reads, working tree against a git revision. See Performance below.
- `scripts/release-notes.ts` prints the release notes for the current build.
- `scripts/update-notes.ts` prints the monthly check's WFS load and source changes.
- `scripts/package-metadata.ts` downloads the package version's released metadata before packing. `scripts/build-package.ts` bundles the Node reader into `lib/index.js`; `tsconfig.package.json` emits its declarations. `scripts/check-package.ts` installs a tarball and checks the offline public API and consumer types.
- `src/` is the reader: `index.ts` has the queries, `store.ts` finds tiles in memory, the cache or the GitHub release and checks them, and `tiles.ts` maps areas to tile names.
- `test/` holds vitest cases. `queries.test.ts` checks answers at fixed points. `store.test.ts` checks downloading and caching against a local server that serves `dist/tiles` the way a release serves assets. Both read `dist/`.

`tmp/`, `dist/` and `lib/` are not committed.

## Getting started

Needs Node 24 (see `mise.toml`), GDAL with FlatGeobuf support for `ogr2ogr` and [t2sz](https://github.com/martinellimarco/t2sz) 1.2.5. On macOS: `brew install gdal t2sz`.

```sh
npm ci
npm run fetch   # about 1,200 serial WFS requests the first time; cached in tmp/ after that
npm run build
npm test
```

`npm run fetch -- --fresh` ignores the cache.

## Checks

CI runs:

```sh
npm ci
npm run lint
npx tsc -p .
npx vitest run test/regulations.test.ts test/package.test.ts
npm run demo:build
gh release download -p tiles.json -p zones.json -D dist
npm run package:build
npm pack --dry-run --ignore-scripts
npm run package:check
```

CI does not run the full vitest suite, because the query tests need built tiles, and building them downloads every layer from VLIZ. The packaging smoke test uses the newest released metadata as a fixture and skips prepack, so CI can run before the package version's tile release exists. It installs with npm's nested strategy to catch undeclared runtime imports, calls `tilesFor()` without network access, and checks the shipped declarations with TypeScript. Publishing always runs prepack against the exact version's release. Run `npm test` locally after `npm run build`. Before changing query or build logic, also run `node scripts/check.ts`, which should report 0 zone mismatches and distance errors under 1%.

A separate CI job benchmarks the queries when `src/`, `benchmarks/`, the dependencies or the workflow change. It uses the released tiles, so it needs no build.

## Performance

Benchmark the working tree against a git revision:

```sh
gh release download -p tiles.json -p zones.json -D dist
node benchmarks/run.ts --base origin/main
```

The first line is only needed without a local build: the reader checks tiles against the hashes in `dist/tiles.json`, so it must be a release's copy. Tiles are downloaded from the release named by `package.json`; between a version bump and its release, pass `--release v<newest>` to use the release the metadata came from, which is what CI always does. The command measures uncommitted edits too. Omit `--base` to compare against `HEAD`.

Each workload in [`benchmarks/cases.json`](benchmarks/cases.json) is one query at one position, and runs in two modes. `offline` calls the public API over tiles in the cache, the way a Node consumer does. `range` drives the shared query code in `src/queries.ts` over HTTP range reads of the compressed tiles from a local server, the way the browser demo does, and also counts the requests and bytes one call makes. Pass `--mode offline` or `--mode range` to run one, and `--skip` with a regular expression matched against workload names to leave some out. Bases older than `src/queries.ts` only run offline.

Both revisions use the current harness, tiles, dependencies and machine. The base is exported to a temporary directory, so the command never switches your checkout. Before timing, every tile the workloads can touch is downloaded into the reader's cache (`~/.cache/openwaters/maritime-zones/v<version>`, or `--cache` to use another directory, such as `dist/tiles` after a local build). Each workload gets seven pairs of base and candidate processes, alternating which runs first. A process warms up for 300 milliseconds, which includes loading its tiles, then the first pair calibrates a batch of at least 100 milliseconds and later pairs reuse it.

The table reports median milliseconds per call and, for range mode, requests and bytes per call. A median slowdown above 20 percent fails the command, and so does a 20 percent rise in requests or bytes; `--threshold 10` tests another limit. The threshold is a policy limit; `npm test` and `scripts/check.ts` are the accuracy gates, and a workload whose answer differs between revisions fails the comparison outright. Timing is noisy on a busy machine, so repeat a suspicious run. Requests and bytes are exact.

Raw samples, checksums, revisions, harness hash and machine metadata are saved under `.benchmarks/<timestamp>/` with `summary.md`; `--output` picks the directory. Compare saved reports from the same machine and harness with:

```sh
node benchmarks/compare.ts base.json candidate.json 20
```

CI compares a pull request with its base, or a push to `main` with the previous commit, publishes the table in the Actions summary and keeps the reports as an artifact for 30 days. The tile cache is kept between runs, keyed on the package version and the workloads.

## Pages demos

`demo/` contains the five map views, Browser and Node.js snippets, and the separate Canadian 3 NM example rule. `src/queries.ts` supplies the same geometry logic to the Node reader and browser range reader; regulations stay in the demo. Missing country rules, overlapping territory contexts and unknown distances do not produce a discharge decision. The example measures the coastline in the selected release and does not model legal baselines or the remaining conditions in section 96. Its attribution follows the selected release: OpenStreetMap for `v0.1.0`, World Countries for the `v0.2.0` build.

To preview using the existing published tiles without fetching upstream data:

```sh
npm ci
TILE_VERSION=v0.1.0 npm run demo:build
mkdir -p public/v0.1.0
gh release download v0.1.0 --dir public/v0.1.0
TILE_VERSION=v0.1.0 npm run demo:dev
```

Open `http://127.0.0.1:4173/`. The local server supports the suffix byte ranges the seekable reader requires. To preview a different release, download its assets into `public/<tag>/` and set `TILE_VERSION=<tag>` when building or starting the preview. For Node snippets, also download that release's `tiles.json` and `zones.json` into `dist/`.

The **Deploy demos** workflow rebuilds Pages on relevant pushes to main, or on manual dispatch. It downloads the latest existing tile release and builds only the demo: no WFS requests, source rebuild, release replacement or npm publication. The release workflow also builds the demo when publishing new tiles. Both deployments preserve the navigation and discharge notice and the attribution for the selected tile release.

## Monthly upstream check

The **Check upstream data** workflow runs from the default branch on the first of each month at 07:17 UTC. GitHub may delay scheduled runs. To measure a run sooner, select **Run workflow** in its Actions page or run `gh workflow run updates.yml`.

Each run fetches the six maritime-zone layers and World Countries serially with `npm run fetch -- --fresh`. It compares `upstream.lock.json` with the committed version. Changed data is built and tested before the workflow opens or updates a single PR on `update-upstream`. The PR lists each changed layer's old and new title, feature count and hash. Unchanged data creates no PR. If an outstanding update reverts to the committed data, its PR is closed. No release, Pages deployment or npm publication occurs.

The run summary and the `upstream-load` artifact retain the load report for 90 days, including partial figures on fetch failure. `tmp/fetch-stats.json` records start/end times, success, elapsed time, actual WFS request attempts, retries and response bytes. Cached features and indexes avoid WFS requests, but every invocation still fetches capabilities once, even with a full cache. Response bytes count UTF-8 response bodies after HTTP decompression, including HTTP error responses; they do not measure wire traffic or server CPU. WFS time includes retry waits, and all source downloads are included in the WFS counters.

With the current lock, a fresh check needs 1,174 WFS requests before retries: one capabilities request, seven feature indexes and 1,166 individual features (872 maritime zones and 294 country features). The artifact records the actual count if upstream changes or retries occur. The WFS hashes ignore response timestamps, so an unchanged source does not produce an update just because it was fetched again.

VLIZ confirmed that the proposed monthly load is acceptable. Share the run's actual load report if the strategy or source coverage changes materially. If VLIZ asks for less frequent fetching or a capabilities-first check, change the schedule or fetch strategy in a PR. If they ask us to stop, remove the schedule and avoid manual fetches until resolved.

Marine Regions announces releases through a newsletter sent to users who fill in their details through the download form. Maintainers should register there and review announcements alongside the monthly source comparison. The [LDES feed](https://www.marineregions.org/feed.ttl) also includes general gazetteer changes; a feed event is not necessarily a maritime-boundary release. An [hourly feed page](https://www.marineregions.org/feed.ttl?page=2026-09-30T22%3A00%3A00Z%2F2026-09-30T23%3A00%3A00Z) shows the time-window URL format. The monthly workflow compares the source features directly instead of interpreting every gazetteer event as a release.

## Coastline source and VLIZ reply

Coastlines use the updated World Countries Geodatabase served as `MarineRegions:worldcountries_esri_2014`. Britt Lonneville of the Marine Regions team identified it as the normal-baseline source used for maritime-zone calculations and supplied this citation:

Flanders Marine Institute (2020). World Countries Geodatabase. https://marineinfo.org/doc/dataset/8873

The [dataset record](https://marineinfo.org/doc/dataset/8873) specifies CC-BY 4.0 and describes ESRI World Countries 2014, with data from DeLorme (2014), adapted for consistency with the maritime boundaries. NOTICE preserves both the VLIZ citation and ESRI/DeLorme source attribution. The WFS cache uses `tmp/countries/`; `scripts/build.ts` simplifies and chunks every country polygon ring into `kind: "land", zone: -1` lines. Countries stay out of `zones.json`, and land-distance results retain `zone: null`. Cached `tmp/land/` and OSM coastline files are not used.

The reply approves the proposed derived-tile redistribution and monthly load. VLIZ explained that the download restrictions help prevent deprecated versions circulating and allow user tracking, and accepted that maintainers will watch for updates. [Issue #11](https://github.com/openwatersio/maritime-zones/issues/11) tracks the correspondence and usage notification. Marine Regions also invited a listing on its users page; the maintainer handles that reply and newsletter registration.

The source confirmation names `worldcountries_esri_2014`, not `land_v9`. World Countries is a proxy for normal baselines. Country rings include inland borders and holes, and the build does not model straight or archipelagic legal baselines, low-water observations or discharge rules. Redistribution permission does not change the navigation or legal-use limitations.

The World Countries build is version `0.2.0`. Publish it as a new tiles release after reviewing `upstream.lock.json`, rebuilding, running `npm test` and `node scripts/check.ts`, and checking the new tile counts, sizes and hashes. Require 0 zone mismatches and distance errors under 1%. Verify the fresh-cache Belgian query and Pages range reads against that release's metadata. Keep `v0.1.0` and its OSM assets unchanged: changing coastlines changes hashes, and caches are separated by version. Releases containing OSM data retain their own attribution and ODbL terms. npm publication is authorized and follows the matching tile release.

## Releases

See [Tile format](docs/tile-format.md) for the seekable zstd format, compression measurements, range reads and what the download hashes cover.

Tiles ship as flat assets on the GitHub release `v<version>`, where `<version>` is the one in `package.json`: every `dist/tiles/*.fgb.zst` plus `dist/zones.json`, `dist/tiles.json` and `NOTICE`. Raw `.fgb` intermediates stay local for the GDAL distance oracle. The reader downloads tiles from the release matching its own version and checks them against the hashes in its packaged `tiles.json`, so a release is never replaced. New tiles need a new version.

To release tiles:

1. Review unfinished specs and plans, preserve lasting guidance in maintained docs, and remove completed plans. Have a human review documentation changes in the release PR. If either source has changed, run `npm run fetch -- --fresh` and commit the new `upstream.lock.json` in a pull request. The release workflow refuses to publish data that differs from the committed lock.
2. Bump `version` in `package.json` in a pull request.
3. Run the **Release tiles** workflow from the Actions tab. It fetches the maritime boundaries and World Countries from VLIZ, builds and compresses the tiles, runs the tests against them and writes the release notes to the run summary. With `dry_run` left on, the default, that's all it does. With `dry_run` off, it creates a draft release, uploads every compressed tile plus both metadata files and NOTICE, checks the count, publishes, verifies a query from an empty cache and deploys the identical files to Pages.

Uploads are spaced eight seconds apart to stay below [GitHub's content-creation limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), so uploading a full global build takes about 80 minutes. Rate limits honor GitHub's retry delay, with bounded backoff. If a run stops with a draft, rerun the workflow: it checks every existing asset's hash and uploads only missing files. If those hashes differ, delete the draft and start again. Published releases cannot be resumed or replaced.

The npm package carries `zones.json` and `tiles.json` from the release it points at. `prepack` downloads those exact files, then builds JavaScript and declarations in `lib/`. It refuses to pack without the matching release, even if locally built metadata exists. Tiles stay out of the tarball. `lib/flatgeobuf.LICENSE` covers the bundled FlatGeobuf reader; its dependencies stay external. FlatGeobuf 4.5.0 is bundled with console calls dropped because its deep entry logs every index node. Once a release includes [flatgeobuf#533](https://github.com/flatgeobuf/flatgeobuf/pull/533), use its public `flatgeobuf/geojson` entry and remove this fallback.

VLIZ has approved the proposed derived-tile redistribution through GitHub releases and Pages. Maintainers monitor Marine Regions updates to avoid distributing deprecated versions. Coastlines come from World Countries under CC-BY 4.0; `land_v9` is not fetched or built.

### npm publication

The first public package is `@openwaters/maritime-zones@0.2.0`. Publish the `v0.2.0` tiles first, then run these checks from the reviewed package commit:

```sh
npm ci
npm run lint
npx tsc -p .
npx vitest run test/regulations.test.ts test/package.test.ts
npm pack --dry-run
npm run package:check
npm publish
```

The first publish needs a maintainer's npm login and two-factor authentication. Register npm's GitHub Actions trusted publisher after the package exists: owner `openwatersio`, repository `maritime-zones`, workflow `publish.yml`, no environment. No npm token is stored in GitHub. The tile tag is required before this manual npm publish; do not recreate it or republish the immutable tiles afterward.

For later versions, publish the matching tiles, then dispatch **Publish npm package** on `main`. It verifies packaging and publishes with OIDC and provenance. A release published by a human also triggers it at the release tag; releases created with the tile workflow's `GITHUB_TOKEN` do not trigger another workflow, so they require the explicit dispatch. Never dispatch the npm workflow for the hand-published first version. Verify the workflow result and `npm view @openwaters/maritime-zones version` before reporting a publication complete.

Enable GitHub Pages with GitHub Actions as its source before publishing. The mirror serves the latest release at `https://openwatersio.github.io/maritime-zones/v<version>/`, with the same filenames and SHA-256 as the release. Set `baseUrl` to that URL for whole-tile downloads. For browser range queries, host the demo on the same Pages origin and use FlatGeobuf with `seekableZstd: true`; Pages does not expose the `Content-Range` header to other origins. See [Tile format](docs/tile-format.md).

## Gotchas

- flatgeobuf's in-memory reader returns wrong features, or throws `Invalid header size`, when given a Node `Buffer` or a `Uint8Array` with a `byteOffset`. The reader copies each tile into a fresh `Uint8Array`. See [flatgeobuf#526](https://github.com/flatgeobuf/flatgeobuf/issues/526).
- flatgeobuf's `packedrtree` calls `console.debug` for every index node it visits, and there is no option to turn it off. Silence `console.debug` in scripts, or the output buries everything else.
- The flatgeobuf npm writer does not build a spatial index, so tiles are written with GDAL.
- The GDAL FlatGeobuf driver cannot overwrite a layer. Delete the output file before running `ogr2ogr`.
- Every WFS response carries a fresh `timeStamp`, so `upstream.lock.json` hashes only the features. Hashing the raw response would change the lock on every fetch.
- Scripts and tests that read a local build call `configure({ cacheDir: "dist/tiles", download: false })`. Without it the reader looks in the user cache and tries to download from a release that may not exist.
- A point on an island is in no zone: islands are holes in every zone polygon. An empty `whereAmI` on land is correct.
