import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { releaseMetadata } from "../scripts/package-metadata.ts";
import { ROOT } from "../scripts/layers.ts";

afterEach(() => vi.unstubAllGlobals());

test("package builds remove obsolete JavaScript and declarations before emitting fresh artifacts", () => {
  mkdirSync(join(ROOT, "lib/obsolete"), { recursive: true });
  writeFileSync(join(ROOT, "lib/obsolete/removed.js"), "export const obsolete = true;");
  writeFileSync(join(ROOT, "lib/removed.d.ts"), "export declare const obsolete: boolean;");
  execFileSync("npm", ["run", "package:build"], { cwd: ROOT, stdio: "pipe" });
  expect(existsSync(join(ROOT, "lib/obsolete"))).toBe(false);
  expect(existsSync(join(ROOT, "lib/removed.d.ts"))).toBe(false);
  expect(existsSync(join(ROOT, "lib/index.js"))).toBe(true);
  expect(existsSync(join(ROOT, "lib/index.d.ts"))).toBe(true);
});

test("packaging takes both metadata files from the pinned tile release", async () => {
  const fetch = vi.fn(async (url: string) => new Response(url.endsWith("tiles.json") ? '{"tiles":{}}' : "[]"));
  vi.stubGlobal("fetch", fetch);
  expect(await releaseMetadata()).toEqual([
    ["tiles.json", '{"tiles":{}}'],
    ["zones.json", "[]"],
  ]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://github.com/openwatersio/maritime-zones/releases/download/v0.2.0/tiles.json",
    "https://github.com/openwatersio/maritime-zones/releases/download/v0.2.0/zones.json",
  ]);
});

test("packaging refuses missing releases and invalid JSON", async () => {
  vi.stubGlobal("fetch", async () => new Response("Not found", { status: 404 }));
  await expect(releaseMetadata("0.2.0")).rejects.toThrow("v0.2.0/tiles.json: HTTP 404");
  vi.stubGlobal("fetch", async () => new Response("Not JSON"));
  await expect(releaseMetadata("0.2.0")).rejects.toThrow(SyntaxError);
});
