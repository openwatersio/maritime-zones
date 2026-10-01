import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { compare, type Report, type Sample } from "../benchmarks/compare.ts";
import { configure, whereAmI } from "../src/index.ts";

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
    const expected = (await whereAmI(51.25, 2.85)).reduce((sum, z) => sum + z.mrgid, 0);
    const result = measure("offline", "whereAmI/off-ostend");
    expect(result).toMatchObject({ name: "whereAmI/off-ostend", mode: "offline", checksum: expected });
    expect(result.samplesMs).toHaveLength(1);
    expect(result.samplesMs[0]).toBeGreaterThan(0);
    expect(result.iterations).toBeGreaterThanOrEqual(1);
    expect(result.requests).toBeUndefined();
    expect(measure("offline", "whereAmI/off-ostend", "3").iterations).toBe(3);
  }, 60_000);

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
