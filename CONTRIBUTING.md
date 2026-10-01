# Contributing

## Layout

- `scripts/fetch.ts` downloads every layer from the VLIZ WFS into `tmp/`, one feature per request, and writes `upstream.lock.json`.
- `scripts/build.ts` turns `tmp/` into `dist/zones.json`, `dist/tiles.json` and `dist/tiles/*.fgb`.
- `scripts/layers.ts` lists the upstream layers and paths shared by the scripts.
- `scripts/check.ts` compares answers at random points with the live WFS and with exact GDAL distances.
- `scripts/bench.ts` prints answers at fixed points and times each query.
- `scripts/release-notes.ts` prints the release notes for the current build.
- `src/` is the reader: `index.ts` has the queries, `store.ts` finds tiles in memory, the cache or the GitHub release and checks them, and `tiles.ts` maps areas to tile names.
- `test/` holds vitest cases. `queries.test.ts` checks answers at fixed points. `store.test.ts` checks downloading and caching against a local server that serves `dist/tiles` the way a release serves assets. Both read `dist/`.

`tmp/` and `dist/` are not committed.

## Getting started

Needs Node 24 (see `mise.toml`) and GDAL with FlatGeobuf support for `ogr2ogr`.

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

## Releases

See [Tile format](docs/tile-format.md) for the seekable zstd format, compression measurements, range reads and what the download hashes cover.

Tiles ship as flat assets on the GitHub release `v<version>`, where `<version>` is the one in `package.json`: every `dist/tiles/*.fgb` plus `dist/zones.json` and `dist/tiles.json`. The reader downloads tiles from the release matching its own version and checks them against the hashes in its packaged `tiles.json`, so a release is never replaced. New tiles need a new version.

To release:

1. If Marine Regions has changed, run `npm run fetch` and commit the new `upstream.lock.json` in a pull request. The release workflow refuses to publish data that differs from the committed lock.
2. Bump `version` in `package.json` in a pull request.
3. Run the **Release tiles** workflow from the Actions tab. It fetches every layer from VLIZ (about 30 minutes), builds the tiles, runs the tests against them and writes the release notes to the run summary. With `dry_run` left on, the default, that's all it does. With `dry_run` off, it creates a draft release, uploads the 606 assets, checks the count and then publishes.

The npm package must carry the `zones.json` and `tiles.json` from the release it points at; take them from the release rather than rebuilding.

Nothing is published yet. The package is `private`: Marine Regions asks that its products not be offered for download elsewhere, and we have asked VLIZ whether derived tiles are acceptable and whether the `land_v9` coastline is CC-BY. Run the workflow with `dry_run` off only after they answer. Publishing to npm also needs a JavaScript build, because Node does not strip TypeScript types inside `node_modules`.

## Gotchas

- flatgeobuf's in-memory reader returns wrong features, or throws `Invalid header size`, when given a Node `Buffer` or a `Uint8Array` with a `byteOffset`. The reader copies each tile into a fresh `Uint8Array`. See [flatgeobuf#526](https://github.com/flatgeobuf/flatgeobuf/issues/526).
- flatgeobuf's `packedrtree` calls `console.debug` for every index node it visits, and there is no option to turn it off. Silence `console.debug` in scripts, or the output buries everything else.
- The flatgeobuf npm writer does not build a spatial index, so tiles are written with GDAL.
- The GDAL FlatGeobuf driver cannot overwrite a layer. Delete the output file before running `ogr2ogr`.
- Every WFS response carries a fresh `timeStamp`, so `upstream.lock.json` hashes only the features. Hashing the raw response would change the lock on every fetch.
- Scripts and tests that read a local build call `configure({ cacheDir: "dist/tiles", download: false })`. Without it the reader looks in the user cache and tries to download from a release that may not exist.
- A point on an island is in no zone: islands are holes in every zone polygon. An empty `whereAmI` on land is correct.
