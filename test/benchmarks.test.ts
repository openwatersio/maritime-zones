import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { compare, type Report, type Sample } from "../benchmarks/compare.ts";
import { digest } from "../benchmarks/digest.ts";
import { ahead, configure, whereAmI } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TILES = join(ROOT, "dist", "tiles");

const sample = (samplesMs: number[], extra: Partial<Sample> = {}): Sample => ({
  name: "nearestTerritory/dover",
  mode: "offline",
  iterations: 10,
  checksum: 6.29,
  samplesMs,
  ...extra,
});
const report = (samplesMs: number[], extra: Partial<Sample> = {}): Report => ({
  harness: "same-workloads",
  environment: { runtime: "node 24", platform: "linux", arch: "x64", cpu: "test CPU" },
  revision: "abc",
  dirty: false,
  recordedAt: "2026-10-01T00:00:00Z",
  results: [sample(samplesMs, extra)],
});
const seven = (ms: number) => Array<number>(7).fill(ms);

describe("compare", () => {
  test("explicit unavailable base workloads are measured and displayed as new", () => {
    const base = report(seven(10));
    base.unavailable = [{ name: "ahead/dutch-coast", mode: "offline" }];
    const candidate = structuredClone(base);
    delete candidate.unavailable;
    candidate.results.push(sample(seven(3), { name: "ahead/dutch-coast", checksum: 123 }));
    const result = compare(base, candidate);
    expect(result.regressed).toBe(false);
    expect(result.markdown).toMatch(/ahead\/dutch-coast.*new/);
    const onlyNew = { ...base, results: [] };
    const onlyCandidate = { ...candidate, results: candidate.results.slice(1) };
    expect(compare(onlyNew, onlyCandidate).regressed).toBe(false);
    delete base.unavailable;
    expect(() => compare(base, candidate)).toThrow(/Workload set changed/);
  });
  test("gates median regressions, tolerates outliers, and reports improvements", () => {
    const base = report([10, 10, 10, 10, 10, 10, 100]);
    const regression = compare(base, report([12.1, 12.1, 12.1, 12.1, 12.1, 12.1, 1]), 20);
    expect(regression.regressed).toBe(true);
    expect(regression.markdown).toMatch(/\+21\.0%/);
    expect(compare(base, report([12, 12, 12, 12, 12, 12, 100]), 20).regressed).toBe(false);
    const faster = compare(base, report([8, 8, 8, 8, 8, 8, 100]), 20);
    expect(faster.regressed).toBe(false);
    expect(faster.markdown).toMatch(/-20\.0%/);
    expect(compare(base, report(seven(11)), 5).regressed).toBe(true);
  });

  test("range workloads also regress on requests or bytes, even when time is flat", () => {
    const range = { mode: "range" as const, requests: 100, bytes: 1_000_000 };
    const base = report(seven(10), range);
    expect(compare(base, report(seven(10), range), 20).regressed).toBe(false);
    expect(compare(base, report(seven(10), { ...range, requests: 121 }), 20).regressed).toBe(true);
    expect(compare(base, report(seven(10), { ...range, bytes: 1_200_001 }), 20).regressed).toBe(true);
    const fewer = compare(base, report(seven(10), { ...range, requests: 50, bytes: 500_000 }), 20);
    expect(fewer.regressed).toBe(false);
    expect(fewer.markdown).toMatch(/100 → 50/);
  });

  test("fails closed on incomparable or incomplete reports", () => {
    const base = report(seven(10));
    const mutations: ((r: Report) => void)[] = [
      (r) => (r.harness = "different-workloads"),
      (r) => (r.environment.runtime = "different runtime"),
      (r) => (r.results = []),
      (r) => (r.results[0]!.name = "renamed"),
      (r) => (r.results[0]!.mode = "range"),
      (r) => r.results.push(r.results[0]!),
      (r) => (r.results[0]!.samplesMs = []),
      (r) => (r.results[0]!.samplesMs = seven(10).slice(1)),
      (r) => (r.results[0]!.samplesMs[0] = NaN),
      (r) => (r.results[0]!.samplesMs[0] = 0),
      (r) => (r.results[0]!.checksum = 0),
      (r) => (r.results[0]!.checksum += 1e-6),
      (r) => (r.results[0]!.checksum = Infinity),
      (r) => (r.results[0]!.iterations = 0),
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(base);
      mutate(candidate);
      expect(() => compare(base, candidate, 20), mutate.toString()).toThrow();
    }
    for (const threshold of [-1, NaN, Infinity]) expect(() => compare(base, base, threshold)).toThrow();
    const missingMetadata = { ...base, environment: {} as Report["environment"] };
    expect(() => compare(missingMetadata, missingMetadata, 20)).toThrow();
    // A range workload without its counters is incomplete.
    const noCounters = report(seven(10), { mode: "range" });
    expect(() => compare(noCounters, noCounters, 20)).toThrow();
  });

  test("CLI returns a failure status for a regression or invalid input", () => {
    const dir = mkdtempSync(join(tmpdir(), "maritime-zones-compare-"));
    try {
      const base = join(dir, "base.json");
      const candidate = join(dir, "candidate.json");
      writeFileSync(base, JSON.stringify(report(seven(10))));
      const run = (...extra: string[]) =>
        spawnSync(process.execPath, [join(ROOT, "benchmarks/compare.ts"), base, candidate, ...extra], {
          encoding: "utf8",
        });
      writeFileSync(candidate, JSON.stringify(report(seven(13))));
      const slower = run();
      expect(slower.status).toBe(1);
      expect(slower.stdout).toMatch(/REGRESSION/);
      expect(run("40").status).toBe(0);
      expect(run("NaN").status).toBe(1);
      writeFileSync(candidate, "{broken JSON");
      expect(run().status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("digest", () => {
  const zone = (mrgid: number, layer = "eez") => ({ layer, mrgid }) as any;
  const hit = (extra = {}) => ({
    distanceNm: 6.29,
    bearingDeg: 143,
    point: [51.05, 1.47] as [number, number],
    zone: zone(3293),
    ...extra,
  });
  test("course fingerprints include start, distance, point, kind, both parties and joint claims", () => {
    const answer: any = {
      start: [{ ...zone(1), iso_ter: "NLD" }],
      crossings: [
        {
          kind: "water",
          distanceNm: 1,
          point: [51, 2],
          leaving: [{ ...zone(1), iso_ter: "NLD" }],
          entering: [{ ...zone(2), iso_ter: "BEL", iso_ter2: "FRA" }],
        },
      ],
    };
    const mutations: ((a: any) => void)[] = [
      (a) => (a.start[0].iso_ter = "FRA"),
      (a) => (a.crossings[0].distanceNm = 2),
      (a) => (a.crossings[0].point[0] = 52),
      (a) => (a.crossings[0].leaving = []),
      (a) => (a.crossings[0].entering[0].iso_ter2 = "DEU"),
      (a) => (a.crossings[0].kind = "coast"),
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(answer);
      mutate(changed);
      expect(digest(changed)).not.toBe(digest(answer));
    }
    expect(digest(answer)).toBe(digest(structuredClone(answer)));
  });

  test("tells apart zone sets with the same id sum and hits that differ only in bearing, point or zone", () => {
    expect(digest([zone(1), zone(4)])).not.toBe(digest([zone(2), zone(3)]));
    expect(digest([zone(1, "12nm"), zone(4)])).not.toBe(digest([zone(1), zone(4)]));
    expect(digest(hit())).not.toBe(digest(hit({ bearingDeg: 144 })));
    expect(digest(hit())).not.toBe(digest(hit({ point: [51.06, 1.47] })));
    expect(digest(hit())).not.toBe(digest(hit({ zone: zone(3294) })));
    expect(digest(hit())).not.toBe(digest(null));
  });

  test("ignores floating-point noise below a micro-degree and is a safe integer", () => {
    expect(digest(hit({ distanceNm: 6.29 + 1e-9 }))).toBe(digest(hit()));
    expect(digest(hit({ bearingDeg: 143 + 1e-9 }))).toBe(digest(hit()));
    expect(Number.isSafeInteger(digest(hit()))).toBe(true);
  });
});

describe("measure", () => {
  // One warmed sample per process, the way run.ts spawns it. Needs the tiles in dist/.
  const measure = (mode: string, name: string, ...extra: string[]): Sample =>
    JSON.parse(
      execFileSync(process.execPath, [join(ROOT, "benchmarks/measure.ts"), ROOT, mode, name, ...extra], {
        encoding: "utf8",
        env: { ...process.env, MARITIME_ZONES_CACHE: TILES },
      }),
    );

  test("the offline sample carries the checksum of the real answer", async () => {
    configure({ cacheDir: TILES, download: false });
    const expected = digest(await whereAmI(51.25, 2.85));
    const result = measure("offline", "whereAmI/off-ostend");
    expect(result).toMatchObject({ name: "whereAmI/off-ostend", mode: "offline", checksum: expected });
    expect(result.samplesMs).toHaveLength(1);
    expect(result.samplesMs[0]).toBeGreaterThan(0);
    expect(result.iterations).toBeGreaterThanOrEqual(1);
    expect(result.requests).toBeUndefined();
    expect(measure("offline", "whereAmI/off-ostend", "3").iterations).toBe(3);
  }, 60_000);
  test("course measurements agree between offline and range modes", async () => {
    configure({ cacheDir: TILES, download: false });
    const expected = digest(await ahead(52.2, 4.2, 225, { maxNm: 120 }));
    const offline = measure("offline", "ahead/dutch-coast");
    const range = measure("range", "ahead/dutch-coast");
    expect(offline.checksum).toBe(expected);
    expect(range.checksum).toBe(expected);
    expect(range.requests).toBeGreaterThan(0);
    expect(range.bytes).toBeGreaterThan(0);
  }, 60000);

  test("the range sample counts requests and bytes and agrees with the offline answer", () => {
    const offline = measure("offline", "nearestTerritory/dover");
    const range = measure("range", "nearestTerritory/dover");
    expect(range.checksum).toBe(offline.checksum);
    expect(range.mode).toBe("range");
    expect(range.requests).toBeGreaterThan(0);
    expect(range.bytes).toBeGreaterThan(0);
  }, 60_000);

  test("an unknown workload is an error", () => {
    expect(() => measure("offline", "whereAmI/nowhere")).toThrow();
  });
});
