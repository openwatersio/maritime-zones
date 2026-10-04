import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./layers.ts";

const work = mkdtempSync(join(tmpdir(), "maritime-zones-package-"));
const { tileVersion } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
try {
  // CI uses released metadata as a fixture; publishing runs prepack against tileVersion.
  const [pack] = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", work], {
      cwd: ROOT,
      encoding: "utf8",
    }),
  );
  const files: string[] = pack.files.map((file: { path: string }) => file.path);
  for (const file of [
    "lib/index.js",
    "lib/index.d.ts",
    "lib/flatgeobuf.LICENSE",
    "dist/zones.json",
    "dist/tiles.json",
    "NOTICE",
    "LICENSE",
  ]) {
    assert(files.includes(file), `Package is missing ${file}`);
  }
  // Tiles and build inputs must never enter the published tarball.
  assert(
    files.every((file) => /^(lib\/|dist\/(zones|tiles)\.json$|package\.json$|README\.md$|NOTICE$|LICENSE$)/.test(file)),
  );
  assert.doesNotMatch(readFileSync(join(ROOT, "lib/index.js"), "utf8"), /console\.debug\(/);
  execFileSync(
    "npm",
    ["install", "--install-strategy=nested", "--ignore-scripts", "--no-audit", "--no-fund", join(work, pack.filename)],
    {
      cwd: work,
      stdio: "pipe",
    },
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from 'node:assert/strict';
      import { join } from 'node:path';
      globalThis.fetch = () => { throw new Error('The smoke test must not use the network'); };
      const { ahead, configure, tilesFor, whereAmI } = await import('@openwaters/maritime-zones');
      configure({ download: false });
      await assert.rejects(whereAmI(51.25, 2.85), error => {
        assert.equal(error.code, 'MISSING_TILE');
        assert(error.message.includes(join(process.env.XDG_CACHE_HOME, 'openwaters', 'maritime-zones', 'v${tileVersion}')));
        return true;
      });
      const requests = [];
      globalThis.fetch = async url => { requests.push(url); return new Response('', { status: 404 }); };
      configure();
      await assert.rejects(whereAmI(51.25, 2.85), { code: 'DOWNLOAD_FAILED' });
      assert.deepEqual(requests, ['https://github.com/openwatersio/maritime-zones/releases/download/v${tileVersion}/n50e0.fgb.zst']);
      globalThis.fetch = () => { throw new Error('The smoke test must not use the network'); };
      configure({ download: false, cacheDir: 'empty-cache' });
      assert.equal(typeof ahead, 'function');
      await assert.rejects(ahead(0, 0, 90, { maxNm: 0 }), RangeError);
      const tiles = tilesFor({ lat: 48.6, lon: -123.2, radiusNm: 5 });
      assert.deepEqual(tiles.map(t => t.tile), ['n40w130']);
      assert(tiles[0].bytes > 0);
      await assert.rejects(whereAmI(51.25, 2.85), { code: 'MISSING_TILE', tile: 'n50e0' });`,
    ],
    { cwd: work, stdio: "pipe", env: { ...process.env, XDG_CACHE_HOME: join(work, "cache") } },
  );
  writeFileSync(
    join(work, "consumer.mts"),
    `import { ahead, tilesFor, whereAmI, type AheadOptions, type AheadResult, type Crossing, type Area, type Zone } from '@openwaters/maritime-zones';
    const area: Area = { lat: 48.6, lon: -123.2, radiusNm: 5 };
    const tiles: { tile: string; bytes: number }[] = tilesFor(area);
    const zones: Promise<Zone[]> = whereAmI(48.6, -123.2);
    const options: AheadOptions = { layers: ['12nm'], maxNm: 80 };
    const course: Promise<AheadResult> = ahead(51.8, 2.85, 180, options);
    function inspect(crossing: Crossing): Zone[] {
      return crossing.kind === 'water' ? crossing.entering.concat(crossing.leaving) : [];
    }`,
  );
  execFileSync(
    join(ROOT, "node_modules/.bin/tsc"),
    ["--noEmit", "--strict", "--module", "nodenext", "--target", "es2024", "consumer.mts"],
    { cwd: work, stdio: "pipe" },
  );
  console.log("Packed JavaScript, declarations and offline consumer import pass.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
