import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./layers.ts";

export async function releaseMetadata(version: string) {
  return Promise.all(
    ["tiles.json", "zones.json"].map(async (name) => {
      const response = await fetch(
        `https://github.com/openwatersio/maritime-zones/releases/download/v${version}/${name}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!response.ok)
        throw new Error(`Release v${version}/${name}: HTTP ${response.status}. Publish tiles before packing.`);
      const json = await response.text();
      JSON.parse(json);
      return [name, json] as const;
    }),
  );
}

if (import.meta.main) {
  const { version } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const files = await releaseMetadata(version);
  await mkdir(join(ROOT, "dist"), { recursive: true });
  for (const [name, json] of files) await writeFile(join(ROOT, "dist", name), json);
}
