import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./layers.ts";

rmSync(join(ROOT, "lib"), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", join(ROOT, "tsconfig.package.json")],
  {
    stdio: "inherit",
  },
);

await build({
  entryPoints: [join(ROOT, "src/index.ts")],
  outfile: join(ROOT, "lib/index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  packages: "external",
  // FlatGeobuf 4.5.0's deep entry logs every index node: https://github.com/flatgeobuf/flatgeobuf/pull/533
  alias: { "flatgeobuf/lib/mjs/geojson.js": join(ROOT, "node_modules/flatgeobuf/lib/mjs/geojson.js") },
  drop: ["console"],
});
copyFileSync(join(ROOT, "node_modules/flatgeobuf/LICENSE"), join(ROOT, "lib/flatgeobuf.LICENSE"));
