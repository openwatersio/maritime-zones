/**
 * Where tiles come from: memory, then the on-disk cache, then the GitHub
 * release matching this package's version. Every tile is checked against the
 * sha256 in tiles.json, which ships with the package, before it is used.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const DATA = new URL("../dist/", import.meta.url);
const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const RELEASES = "https://github.com/openwatersio/maritime-zones/releases/download";
/** Tiles downloaded at once by download(). */
const PARALLEL = 4;

export interface Config {
  /** Where downloaded tiles are kept. Default: $XDG_CACHE_HOME or ~/.cache, under openwaters/maritime-zones/v<version>. */
  cacheDir: string;
  /** Where tiles are downloaded from. Default: this version's GitHub release. */
  baseUrl: string;
  /** Download missing tiles. With false, a missing tile throws MISSING_TILE and nothing touches the network. */
  download: boolean;
}

const defaults = (): Config => ({
  cacheDir: join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "openwaters",
    "maritime-zones",
    `v${VERSION}`,
  ),
  baseUrl: `${RELEASES}/v${VERSION}`,
  download: true,
});

let config = defaults();
const memory = new Map<string, Uint8Array>();
const inflight = new Map<string, Promise<Uint8Array>>();

export function configure(options: Partial<Config>) {
  config = { ...defaults(), ...options };
  memory.clear();
}

let index: Record<string, { bytes: number; sha256: string }> | undefined;
/** Tiles the build wrote, with size and hash. A tile not listed has no features at all. */
export const listed = () =>
  (index ??= JSON.parse(readFileSync(new URL("tiles.json", DATA), "utf8")).tiles as Record<
    string,
    { bytes: number; sha256: string }
  >);

let table: unknown[] | undefined;
export const zoneTable = <T>() => (table ??= JSON.parse(readFileSync(new URL("zones.json", DATA), "utf8"))) as T[];

const fail = (code: string, tile: string, message: string) => Object.assign(new Error(message), { code, tile });
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fromCache(tile: string): Promise<Uint8Array | undefined> {
  let bytes: Uint8Array;
  try {
    // flatgeobuf's ArrayReader assumes it owns the whole ArrayBuffer from byte
    // 0: it builds DataViews on bytes.buffer ignoring byteOffset, and reads index
    // nodes with bytes.slice(...).buffer. Node Buffers break both (small reads
    // are views into a shared pool; Buffer#slice is a view, not a copy), giving
    // wrong features or a crash. A copy into a fresh Uint8Array satisfies both.
    // https://github.com/flatgeobuf/flatgeobuf/issues/526
    bytes = new Uint8Array(await readFile(join(config.cacheDir, `${tile}.fgb`)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // A damaged or foreign file counts as missing.
  return sha256(bytes) === listed()[tile]!.sha256 ? bytes : undefined;
}

async function fromRelease(tile: string): Promise<Uint8Array> {
  const url = `${config.baseUrl}/${tile}.fgb`;
  const response = await fetch(url).catch((error) => {
    throw fail("DOWNLOAD_FAILED", tile, `Could not download tile ${tile} from ${url}: ${error.message}`);
  });
  if (!response.ok)
    throw fail("DOWNLOAD_FAILED", tile, `Could not download tile ${tile} from ${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== listed()[tile]!.sha256) {
    throw fail("CHECKSUM", tile, `Tile ${tile} from ${url} does not match its sha256 in tiles.json.`);
  }
  // Write then rename, so an interrupted download never leaves a partial tile.
  await mkdir(config.cacheDir, { recursive: true });
  const partial = join(config.cacheDir, `${tile}.fgb.${process.pid}.${Math.random().toString(36).slice(2)}.partial`);
  await writeFile(partial, bytes);
  await rename(partial, join(config.cacheDir, `${tile}.fgb`));
  return bytes;
}

/** A tile from the cache or, when allowed, the release; one attempt per tile at a time. */
function ensure(tile: string): Promise<Uint8Array> {
  let pending = inflight.get(tile);
  if (!pending) {
    pending = (async () => {
      const cached = await fromCache(tile);
      if (cached) return cached;
      if (!config.download) {
        throw fail("MISSING_TILE", tile, `Tile ${tile} is not in ${config.cacheDir} and downloads are off.`);
      }
      return fromRelease(tile);
    })().finally(() => inflight.delete(tile));
    inflight.set(tile, pending);
  }
  return pending;
}

/** A tile's bytes, kept in memory after the first read. */
export async function load(tile: string): Promise<Uint8Array> {
  let bytes = memory.get(tile);
  if (!bytes) memory.set(tile, (bytes = await ensure(tile)));
  return bytes;
}

/** Make sure tiles are in the cache, PARALLEL at a time, without holding them in memory. */
export async function fetchAll(names: string[]): Promise<void> {
  const queue = [...names];
  const worker = async () => {
    for (let tile = queue.shift(); tile; tile = queue.shift()) await ensure(tile);
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
}
