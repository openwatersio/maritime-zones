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
  // FlatGeobuf's lib/mjs modules log every index node. Its console-free public entries don't export ArrayReader.
  alias: { flatgeobuf: join(ROOT, "node_modules/flatgeobuf") },
  drop: ["console"],
});
copyFileSync(join(ROOT, "node_modules/flatgeobuf/LICENSE"), join(ROOT, "lib/flatgeobuf.LICENSE"));
