import { afterEach, expect, test, vi } from "vitest";
import { releaseMetadata } from "../scripts/package-metadata.ts";

afterEach(() => vi.unstubAllGlobals());

test("packaging takes both metadata files from the package version's release", async () => {
  const fetch = vi.fn(async (url: string) => new Response(url.endsWith("tiles.json") ? '{"tiles":{}}' : "[]"));
  vi.stubGlobal("fetch", fetch);
  expect(await releaseMetadata("0.2.0")).toEqual([
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
