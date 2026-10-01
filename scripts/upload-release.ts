import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { DIST, ROOT } from "./layers.ts";

const tag = process.argv[2];
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
assert(tag && repo && token, "Release tag, GITHUB_REPOSITORY and GH_TOKEN are required");
const release = JSON.parse(
  execFileSync("gh", ["release", "view", tag, "--json", "apiUrl,assets,isDraft"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  }),
);
assert.equal(release.isDraft, true, "Only draft releases can receive uploads");
const id = new URL(release.apiUrl).pathname.split("/").pop();
const files = [
  join(DIST, "tiles.json"),
  join(DIST, "zones.json"),
  join(ROOT, "NOTICE"),
  ...readdirSync(join(DIST, "tiles"))
    .filter((name) => name.endsWith(".fgb.zst"))
    .map((name) => join(DIST, "tiles", name)),
];
const wait = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// Stay below GitHub's 500 content-generating requests/hour; drafts can resume after backoff.
for (const file of files) {
  const name = basename(file);
  const body = readFileSync(file);
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const existing = release.assets.find((asset: { name: string; digest: string }) => asset.name === name);
  if (existing) {
    assert.equal(
      existing.digest,
      digest,
      `Draft asset ${name} differs from this build; delete the draft before retrying`,
    );
    continue;
  }
  await wait(8);
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(
      `https://uploads.github.com/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body,
      },
    );
    const message = await response.text();
    if (response.ok) {
      console.log(`Uploaded ${name}`);
      break;
    }
    if (![403, 429].includes(response.status) || !/rate limit/i.test(message) || attempt >= 6) {
      throw new Error(`Upload ${name}: HTTP ${response.status}: ${message}`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const reset =
      response.headers.get("x-ratelimit-remaining") === "0"
        ? Number(response.headers.get("x-ratelimit-reset")) - Date.now() / 1000
        : 0;
    const seconds = Math.max(retryAfter, 60 * 2 ** attempt, reset);
    console.log(`Rate limited; waiting ${Math.ceil(seconds)} seconds before retrying ${name}`);
    await wait(seconds);
  }
}
