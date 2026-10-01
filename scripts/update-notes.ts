import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCK, ROOT, TMP } from "./layers.ts";

const stats = JSON.parse(readFileSync(join(TMP, "fetch-stats.json"), "utf8"));
console.log(`Upstream check started ${stats.startedAt}.

${stats.wfs.requests} WFS requests, retries: ${stats.wfs.retries}, ${stats.wfs.responseBytes} response bytes (UTF-8, after HTTP decompression).
WFS fetch: ${stats.wfs.elapsedSeconds ?? stats.elapsedSeconds} seconds. Full fetch: ${stats.elapsedSeconds} seconds.

${stats.ok ? "Fetch succeeded." : "Fetch failed; load figures are partial. No update PR will be created."}
`);
if (process.env.RUN_URL) console.log(`[Workflow run](${process.env.RUN_URL})\n`);
if (stats.ok) {
  type Layer = { title: string; features: number; sha256: string; source?: string };
  const before: Record<string, Layer> = JSON.parse(
    execFileSync("git", ["show", "HEAD:upstream.lock.json"], { cwd: ROOT, encoding: "utf8" }),
  );
  const after: Record<string, Layer> = JSON.parse(readFileSync(LOCK, "utf8"));
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changed = keys.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  const cell = (value: string | number | undefined) =>
    String(value ?? "—")
      .replaceAll("|", "\\|")
      .replace(/[\r\n]/g, " ");
  if (changed.length) {
    console.log(
      "| Layer | Title (old → new) | Features (old → new) | SHA-256 (first 12, old → new) |\n| --- | --- | --- | --- |",
    );
    for (const key of changed) {
      const old = before[key],
        next = after[key];
      console.log(
        `| ${cell(key)} | ${cell(old?.title)} → ${cell(next?.title)} | ${cell(old?.features)} → ${cell(next?.features)} | ${cell(old?.sha256.slice(0, 12))} → ${cell(next?.sha256.slice(0, 12))} |`,
      );
    }
  } else console.log("No source changes; no update PR needed.");
}
