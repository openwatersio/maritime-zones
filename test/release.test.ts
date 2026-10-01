import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("resumes verified draft assets and waits before retrying a rate-limited upload", () => {
  const work = mkdtempSync(join(tmpdir(), "maritime-zones-upload-"));
  try {
    mkdirSync(join(work, "scripts"));
    mkdirSync(join(work, "dist/tiles"), { recursive: true });
    copyFileSync(new URL("../scripts/upload-release.ts", import.meta.url), join(work, "scripts/upload-release.ts"));
    copyFileSync(new URL("../scripts/layers.ts", import.meta.url), join(work, "scripts/layers.ts"));
    writeFileSync(join(work, "package.json"), '{"type":"module"}');
    const tile = Buffer.from("already uploaded tile");
    writeFileSync(join(work, "dist/tiles/n0e0.fgb.zst"), tile);
    for (const file of ["dist/tiles.json", "dist/zones.json", "NOTICE"]) writeFileSync(join(work, file), "{}");
    const release = {
      apiUrl: "https://api.github.com/repos/test/repo/releases/123",
      isDraft: true,
      assets: [{ name: "n0e0.fgb.zst", digest: `sha256:${createHash("sha256").update(tile).digest("hex")}` }],
    };
    writeFileSync(
      join(work, "gh"),
      `#!/usr/bin/env node\nimport assert from 'node:assert/strict';\nassert.deepEqual(process.argv.slice(2), ['release', 'view', 'v0.1.0', '--json', 'apiUrl,assets,isDraft']);\nconsole.log(${JSON.stringify(JSON.stringify(release))});\n`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(
      join(work, "mock.mjs"),
      `
      import { appendFileSync } from 'node:fs';
      let calls = 0;
      globalThis.setTimeout = (callback, ms) => {
        appendFileSync('calls.jsonl', JSON.stringify({ wait: ms }) + '\\n');
        callback();
      };
      globalThis.fetch = async (url, options) => {
        appendFileSync('calls.jsonl', JSON.stringify({ name: new URL(url).searchParams.get('name'), body: options.body.toString() }) + '\\n');
        return calls++ < 2
          ? new Response('secondary rate limit', { status: 403, headers: { 'retry-after': '60' } })
          : new Response('{}', { status: 201 });
      };
    `,
    );
    execFileSync(process.execPath, ["--import", join(work, "mock.mjs"), "scripts/upload-release.ts", "v0.1.0"], {
      cwd: work,
      env: { ...process.env, PATH: `${work}:${process.env.PATH}`, GH_TOKEN: "test", GITHUB_REPOSITORY: "test/repo" },
    });
    const calls = readFileSync(join(work, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.name).map((call) => call.name)).toEqual([
      "tiles.json",
      "tiles.json",
      "tiles.json",
      "zones.json",
      "NOTICE",
    ]);
    expect(calls.filter((call) => call.wait).map((call) => call.wait)).toEqual([8000, 60000, 120000, 8000, 8000]);
    expect(calls.filter((call) => call.body).every((call) => call.body === "{}")).toBe(true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
