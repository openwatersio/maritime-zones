/**
 * Benchmark the working tree against a git revision, offline and over range
 * reads, and gate regressions. See CONTRIBUTING.md, "Performance".
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { arch, cpus, homedir, hostname, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { compare, validate, type Mode, type Report, type Sample } from "./compare.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const bench = join(root, "benchmarks");
const { values } = parseArgs({
  options: {
    base: { type: "string", default: "HEAD" },
    mode: { type: "string", default: "both" },
    output: { type: "string" },
    threshold: { type: "string", default: "20" },
    skip: { type: "string" },
    cache: { type: "string" },
    release: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(
    "Usage: node benchmarks/run.ts [--base git-ref] [--mode offline|range|both] [--output directory] [--threshold percent] [--skip name-regex] [--release tag] [--cache tile-directory]",
  );
  process.exit(0);
}
assert.ok(["offline", "range", "both"].includes(values.mode!), "Unknown mode");
const threshold = Number(values.threshold);
assert.ok(values.threshold!.trim() && Number.isFinite(threshold) && threshold >= 0, "Invalid threshold percentage");
const suite = JSON.parse(readFileSync(join(bench, "cases.json"), "utf8"));
assert.ok(
  Number.isFinite(suite.sampleMs) && suite.sampleMs > 0 && Number.isFinite(suite.warmupMs) && suite.warmupMs >= 0,
  "Invalid sampling settings",
);
assert.ok(Number.isSafeInteger(suite.samples) && suite.samples >= 7, "Fewer than seven samples");
const skip = values.skip === undefined ? null : new RegExp(values.skip);
const selected: { name: string; lat: number; lon: number }[] = suite.cases.filter(
  (spec: { name: string }) => !skip?.test(spec.name),
);
assert.ok(selected.length > 0, "Every workload was skipped");
for (const file of ["tiles.json", "zones.json"]) {
  assert.ok(
    existsSync(join(root, "dist", file)),
    `dist/${file} is missing. Take it from the release: gh release download v<version> -p tiles.json -p zones.json -D dist`,
  );
}

const capture = (command: string, args: string[]) =>
  execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const git = (...args: string[]) => capture("git", args);
const baseRevision = git("rev-parse", "--verify", "--end-of-options", `${values.base}^{commit}`);
const revision = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain").length > 0;
// --release allows comparisons against another tile dataset with its matching metadata.
const tag = values.release ?? `v${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).tileVersion}`;
assert.match(tag, /^v\d+\.\d+\.\d+/, "Invalid release tag");
// Mirrors the reader's defaults in src/store.ts, so a developer's queries and benchmarks share tiles.
const baseUrl = `https://github.com/openwatersio/maritime-zones/releases/download/${tag}`;
const cacheDir = resolve(
  values.cache ?? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "openwaters", "maritime-zones", tag),
);
const output = resolve(values.output ?? join(root, ".benchmarks", new Date().toISOString().replaceAll(":", "-")));
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "maritime-zones-bench-"));
const baseline = join(temp, "source");
const hash = createHash("sha256");
for (const path of ["cases.json", "measure.ts", "digest.ts", "range-server.ts", "run.ts", "compare.ts"]) {
  hash.update(path).update(readFileSync(join(bench, path)));
}
const harness = hash.digest("hex");
const environment = {
  runtime: process.version,
  platform: platform(),
  arch: arch(),
  os: release(),
  cpu: cpus()[0]!.model,
  cores: cpus().length,
  host: hostname(),
};
const summary = [
  "# maritime-zones performance",
  "",
  `Base: ${baseRevision}; candidate: ${revision}${dirty ? " (working tree)" : ""}.`,
  "",
  `Same machine, harness and tiles. ${suite.warmupMs} ms warmup per process, ${suite.samples} interleaved process pairs using batches calibrated to ${suite.sampleMs} ms per workload. Tile downloads and process startup excluded; the first call's tile loading is inside the warmup.`,
  "",
];
if (selected.length < suite.cases.length) {
  const skipped = suite.cases
    .filter((spec: { name: string }) => skip!.test(spec.name))
    .map((s: { name: string }) => s.name);
  summary.push(`Skipped workloads matching /${values.skip}/: ${skipped.join(", ")}.`, "");
}
let regressed = false;
try {
  // Export the base without touching the developer's checkout. Both revisions
  // read the candidate's release metadata and dependencies, so only src/ differs.
  mkdirSync(baseline);
  execFileSync("git", ["archive", "--format=tar", `--output=${join(temp, "base.tar")}`, baseRevision], { cwd: root });
  execFileSync("tar", ["-xf", join(temp, "base.tar"), "-C", baseline]);
  mkdirSync(join(baseline, "dist"), { recursive: true });
  for (const file of ["tiles.json", "zones.json"]) cpSync(join(root, "dist", file), join(baseline, "dist", file));
  symlinkSync(join(root, "node_modules"), join(baseline, "node_modules"));

  const modes = (values.mode === "both" ? ["offline", "range"] : [values.mode]) as Mode[];
  if (modes.includes("range") && !existsSync(join(baseline, "src", "queries.ts"))) {
    modes.splice(modes.indexOf("range"), 1);
    summary.push("Range mode skipped: the base has no src/queries.ts to read over HTTP ranges.", "");
    assert.ok(modes.length > 0, "Nothing to measure: the base cannot run range mode");
  }

  // Every tile a search can touch, so measurements never include a download.
  // 480 NM is MAX_RADIUS in src/queries.ts.
  console.error("Caching tiles...");
  const api = await import(pathToFileURL(join(root, "src", "index.ts")).href);
  api.configure({ cacheDir, baseUrl });
  for (const { lat, lon } of selected) await api.download({ lat, lon, radiusNm: 480 });

  const reports: Record<"base" | "candidate", Report> = {
    base: { harness, environment, revision: baseRevision, dirty: false, recordedAt: "", settings: suite, results: [] },
    candidate: { harness, environment, revision, dirty, recordedAt: "", settings: suite, results: [] },
  };
  const sources = { base: baseline, candidate: root };
  // Keep paired measurements close and alternate which revision runs first,
  // so drift on the machine lands on both sides.
  for (const mode of modes) {
    for (const { name } of selected) {
      console.error(`Measuring ${mode} ${name}...`);
      const previous: Partial<Record<"base" | "candidate", Sample>> = {};
      for (let round = 0; round < suite.samples; round++) {
        const order = (round % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"]) as ("base" | "candidate")[];
        for (const label of order) {
          const fixed = previous[label] ? [String(previous[label].iterations)] : [];
          const sample: Sample = JSON.parse(
            execFileSync(process.execPath, [join(bench, "measure.ts"), sources[label], mode, name, ...fixed], {
              cwd: root,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "inherit"],
              env: { ...process.env, MARITIME_ZONES_CACHE: cacheDir },
            }),
          );
          assert.equal(sample.name, name, "Runner measured the wrong workload");
          assert.equal(sample.samplesMs.length, 1, "Runner must emit one sample per process");
          const earlier = previous[label];
          if (earlier) {
            assert.equal(sample.iterations, earlier.iterations, "Batch size changed");
            assert.ok(
              Math.abs(sample.checksum - earlier.checksum) <= Math.max(1, Math.abs(earlier.checksum)) * 1e-9,
              `Output changed between processes: ${name}`,
            );
            earlier.samplesMs.push(sample.samplesMs[0]!);
          } else {
            previous[label] = sample;
            reports[label].results.push(sample);
          }
        }
      }
    }
  }
  for (const [label, report] of Object.entries(reports)) {
    report.recordedAt = new Date().toISOString();
    validate(report);
    writeFileSync(join(output, `${label}.json`), JSON.stringify(report, null, 2) + "\n");
  }
  const result = compare(reports.base, reports.candidate, threshold);
  regressed = result.regressed;
  summary.push(result.markdown);
  console.log(result.markdown);
  process.exitCode = regressed ? 1 : 0;
} catch (error) {
  summary.push(`Benchmark failed: ${(error as Error).message}`);
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  writeFileSync(join(output, "summary.md"), summary.join("\n") + "\n");
  console.error(`Results: ${output}`);
  rmSync(temp, { recursive: true, force: true });
}
