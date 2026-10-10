import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const metadata = vi.hoisted(() => ({ tiles: {} as Record<string, { bytes: number; sha256: string }> }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (file: URL, encoding: "utf8") =>
      file instanceof URL && file.pathname.endsWith("/dist/tiles.json")
        ? JSON.stringify(metadata)
        : fs.readFileSync(file, encoding),
  };
});

let cacheDir: string;
let store: typeof import("../src/store.ts");
beforeEach(async () => {
  vi.resetModules();
  metadata.tiles = {};
  cacheDir = mkdtempSync(join(tmpdir(), "maritime-zones-memory-"));
  store = await import("../src/store.ts");
  store.configure({ cacheDir, download: false });
});
afterEach(() => {
  store.configure({ download: false });
  rmSync(cacheDir, { recursive: true, force: true });
});

function tile(name: string, mib: number) {
  const compressed = zstdCompressSync(new Uint8Array(mib * 1024 ** 2).fill(7));
  metadata.tiles[name] = {
    bytes: compressed.byteLength,
    sha256: createHash("sha256").update(compressed).digest("hex"),
  };
  writeFileSync(join(cacheDir, `${name}.fgb.zst`), compressed);
}

test("evicts by decompressed bytes and refreshes recency on a hit", async () => {
  tile("a", 32);
  tile("b", 16);
  tile("c", 32);
  const a = await store.load("a");
  const b = await store.load("b");
  expect((await store.load("a")) === a).toBe(true);
  const c = await store.load("c");
  expect((await store.load("a")) === a).toBe(true);
  expect((await store.load("c")) === c).toBe(true);
  expect((await store.load("b")) === b).toBe(false);
  expect((await store.load("c")) === c).toBe(true);
  expect(a[0]).toBe(7);
});

test("evicts enough tiles to accommodate a larger tile", async () => {
  tile("a", 16);
  tile("b", 16);
  tile("c", 16);
  tile("d", 48);
  const a = await store.load("a");
  const b = await store.load("b");
  const c = await store.load("c");
  await store.load("d");
  expect((await store.load("c")) === c).toBe(true);
  expect((await store.load("a")) === a).toBe(false);
  expect((await store.load("b")) === b).toBe(false);
});

test("returns an oversized tile without retaining it or evicting other tiles", async () => {
  tile("a", 1);
  tile("big", 65);
  const a = await store.load("a");
  const big = await store.load("big");
  expect(big.byteLength).toBe(65 * 1024 ** 2);
  expect((await store.load("big")) === big).toBe(false);
  expect((await store.load("a")) === a).toBe(true);
});

test("simultaneous loads share the same decompressed bytes", async () => {
  tile("a", 1);
  const [a, b] = await Promise.all([store.load("a"), store.load("a")]);
  expect(a === b).toBe(true);
  expect((await store.load("a")) === a).toBe(true);
  expect(a.byteOffset).toBe(0);
});

test("configure resets the byte budget as well as the retained tiles", async () => {
  tile("a", 32);
  tile("b", 32);
  tile("c", 32);
  const old = await store.load("a");
  await store.load("b");
  store.configure({ cacheDir, download: false });
  const a = await store.load("a");
  const c = await store.load("c");
  expect(a === old).toBe(false);
  expect((await store.load("a")) === a).toBe(true);
  expect((await store.load("c")) === c).toBe(true);
});

test("a load begun before configure does not repopulate the cleared cache", async () => {
  tile("a", 1);
  const pending = store.load("a");
  store.configure({ cacheDir, download: false });
  const old = await pending;
  expect((await store.load("a")) === old).toBe(false);
});

test("a failed load can be retried after the cache file is restored", async () => {
  tile("a", 1);
  writeFileSync(join(cacheDir, "a.fgb.zst"), "damaged");
  await expect(store.load("a")).rejects.toMatchObject({ code: "MISSING_TILE" });
  tile("a", 1);
  expect((await store.load("a"))[0]).toBe(7);
});
