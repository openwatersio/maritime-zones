/** Compare two benchmark reports and gate regressions. Also a CLI: node benchmarks/compare.ts base.json candidate.json [threshold]. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Mode = "offline" | "range";

export interface Sample {
  name: string;
  mode: Mode;
  iterations: number;
  checksum: number;
  samplesMs: number[];
  /** Range mode only: HTTP requests and bytes for one call. */
  requests?: number;
  bytes?: number;
}

export interface Report {
  harness: string;
  environment: Record<string, string | number>;
  revision: string;
  dirty: boolean;
  recordedAt: string;
  settings?: unknown;
  results: Sample[];
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const key = (s: Sample) => `${s.mode} ${s.name}`;
const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;

export function validate(report: Report): void {
  assert.ok(
    typeof report.harness === "string" && report.harness && report.environment,
    "Missing harness or environment",
  );
  for (const field of ["runtime", "platform", "arch", "cpu"]) {
    assert.ok(
      typeof report.environment[field] === "string" && report.environment[field],
      `Missing environment: ${field}`,
    );
  }
  assert.ok(report.results.length > 0, "Empty benchmark report");
  assert.equal(new Set(report.results.map(key)).size, report.results.length, "Duplicate workloads");
  for (const result of report.results) {
    assert.ok(result.name && Number.isFinite(result.checksum), "Missing name or non-finite checksum");
    assert.ok(result.mode === "offline" || result.mode === "range", `Unknown mode: ${result.mode}`);
    assert.ok(Number.isSafeInteger(result.iterations) && result.iterations > 0, "Invalid iteration count");
    assert.ok(result.samplesMs.length >= 7, "At least seven samples are required");
    assert.ok(
      result.samplesMs.every((v) => Number.isFinite(v) && v > 0),
      "Invalid timing sample",
    );
    if (result.mode === "range")
      assert.ok(count(result.requests) && count(result.bytes), "Range sample lacks counters");
  }
}

const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(a)) * 1e-9;
const mb = (n: number) => `${(n / 1e6).toFixed(2)} MB`;

export function compare(base: Report, candidate: Report, threshold = 20): { regressed: boolean; markdown: string } {
  assert.ok(Number.isFinite(threshold) && threshold >= 0, "Threshold must be a finite, non-negative percentage");
  validate(base);
  validate(candidate);
  for (const field of ["harness", "environment"] as const) {
    assert.deepEqual(candidate[field], base[field], `Incomparable reports: ${field}`);
  }
  assert.deepEqual(candidate.results.map(key).sort(), base.results.map(key).sort(), "Workload set changed");
  const limit = 1 + threshold / 100;
  const rows = [
    "## Query performance",
    "",
    `Median milliseconds per call; regression limit: ${threshold}% on time, and on requests and bytes for range reads.`,
    "",
    "| Workload | Mode | Base ms | Candidate ms | Change | Requests | Bytes | Result |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  let regressed = false;
  for (const current of candidate.results) {
    const previous = base.results.find((r) => key(r) === key(current))!;
    assert.ok(same(current.checksum, previous.checksum), `Workload output changed: ${key(current)}`);
    const before = median(previous.samplesMs);
    const after = median(current.samplesMs);
    const change = (after / before - 1) * 100;
    let failed = after / before > limit;
    let requests = "";
    let bytes = "";
    if (current.mode === "range") {
      requests = `${previous.requests} → ${current.requests}`;
      bytes = `${mb(previous.bytes!)} → ${mb(current.bytes!)}`;
      failed ||= current.requests! > previous.requests! * limit || current.bytes! > previous.bytes! * limit;
    }
    regressed ||= failed;
    const cells = [
      current.name,
      current.mode,
      before.toFixed(2),
      after.toFixed(2),
      `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`,
      requests,
      bytes,
      failed ? "REGRESSION" : "pass",
    ];
    rows.push(`| ${cells.join(" | ")} |`);
  }
  return { regressed, markdown: rows.join("\n") + "\n" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [base, candidate, threshold = "20", extra] = process.argv.slice(2);
    assert.ok(
      base && candidate && !extra && threshold.trim(),
      "Usage: node benchmarks/compare.ts base.json candidate.json [threshold-percent]",
    );
    const result = compare(
      JSON.parse(readFileSync(base, "utf8")),
      JSON.parse(readFileSync(candidate, "utf8")),
      Number(threshold),
    );
    console.log(result.markdown);
    if (result.regressed) process.exitCode = 1;
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
