import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { LAYERS, ROOT } from "../scripts/layers.ts";

const run = promisify(execFile);

it("records actual WFS requests, response bytes and retries, including failed fetches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maritime-fetch-"));
  mkdirSync(join(dir, "scripts"));
  for (const file of ["fetch.ts", "layers.ts"]) copyFileSync(join(ROOT, "scripts", file), join(dir, "scripts", file));
  writeFileSync(join(dir, "scripts/fetch-land.ts"), "export {};\n");
  let requests = 0;
  let bytes = 0;
  let fail = false;
  let terminate: (() => void) | undefined;
  const server = createServer((req, res) => {
    requests++;
    if (terminate) {
      terminate();
      return;
    }
    const query = new URL(req.url!, "http://localhost").searchParams;
    let body: string;
    if (fail || requests === 2) {
      res.statusCode = 503;
      body = "Unavailable";
    } else if (query.get("request") === "GetCapabilities") {
      body = LAYERS.map(({ typeName }) => `<Name>MarineRegions:${typeName}</Name><Title>Café ${typeName}</Title>`).join(
        "",
      );
    } else {
      body = JSON.stringify({ features: [{ properties: { mrgid: 1, title: "Café" } }], timeStamp: Date.now() });
    }
    bytes += Buffer.byteLength(body);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server port");
  writeFileSync(
    join(dir, "redirect.mjs"),
    `const original = globalThis.fetch; globalThis.fetch = url => original("http://127.0.0.1:${address.port}/?" + new URL(url).searchParams);`,
  );
  const fetch = (...args: string[]) =>
    run(process.execPath, ["--import", join(dir, "redirect.mjs"), join(dir, "scripts/fetch.ts"), ...args]);
  const stats = () => JSON.parse(readFileSync(join(dir, "tmp/fetch-stats.json"), "utf8"));
  try {
    await fetch("--fresh");
    expect(stats()).toMatchObject({ ok: true, wfs: { requests: 14, retries: 1, responseBytes: bytes } });
    expect(stats().elapsedSeconds).toBeGreaterThan(0);
    const lock = readFileSync(join(dir, "upstream.lock.json"), "utf8");
    requests = bytes = 0;
    await fetch();
    expect(stats()).toMatchObject({ ok: true, wfs: { requests: 1, retries: 0, responseBytes: bytes } });
    expect(readFileSync(join(dir, "upstream.lock.json"), "utf8")).toBe(lock);
    requests = bytes = 0;
    fail = true;
    await expect(fetch("--fresh")).rejects.toThrow("WFS 503");
    expect(stats()).toMatchObject({ ok: false, wfs: { requests: 3, retries: 2, responseBytes: bytes } });
    const child = spawn(
      process.execPath,
      ["--import", join(dir, "redirect.mjs"), join(dir, "scripts/fetch.ts"), "--fresh"],
      { stdio: "ignore" },
    );
    terminate = () => {
      child.kill("SIGTERM");
    };
    const [code, signal] = await once(child, "exit");
    expect(code).toBe(143);
    expect(signal).toBeNull();
    expect(stats()).toMatchObject({ ok: false, wfs: { requests: 1, retries: 0, responseBytes: 0 } });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

it("reports source changes and load, including hash-only changes and unchanged data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maritime-update-"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "tmp"));
  try {
    for (const file of ["update-notes.ts", "layers.ts"])
      copyFileSync(join(ROOT, "scripts", file), join(dir, "scripts", file));
    const old = {
      eez: { title: "EEZ old", features: 2, sha256: "aaa" },
      land: { title: "OSM", features: 3, sha256: "bbb" },
    };
    writeFileSync(join(dir, "upstream.lock.json"), JSON.stringify(old));
    await run("git", ["init", "--quiet"], { cwd: dir });
    await run("git", ["add", "upstream.lock.json"], { cwd: dir });
    await run(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "Baseline"],
      { cwd: dir },
    );
    writeFileSync(
      join(dir, "tmp/fetch-stats.json"),
      JSON.stringify({
        startedAt: "2026-10-01T07:17:00Z",
        elapsedSeconds: 12,
        ok: true,
        wfs: { requests: 14, retries: 1, responseBytes: 12345 },
      }),
    );
    writeFileSync(
      join(dir, "upstream.lock.json"),
      JSON.stringify({ eez: { title: "EEZ | new", features: 4, sha256: "ccc" }, land: { ...old.land, sha256: "ddd" } }),
    );
    const notes = () => run(process.execPath, [join(dir, "scripts/update-notes.ts")], { cwd: dir });
    const { stdout } = await notes();
    expect(stdout).toContain("14 WFS requests");
    expect(stdout).toContain("12345 response bytes");
    expect(stdout).toContain("retries: 1");
    expect(stdout).toContain("| eez | EEZ old → EEZ \\| new | 2 → 4 | aaa → ccc |");
    expect(stdout).toContain("| land | OSM → OSM | 3 → 3 | bbb → ddd |");
    writeFileSync(join(dir, "upstream.lock.json"), JSON.stringify(old));
    expect((await notes()).stdout).toContain("No source changes");
    writeFileSync(
      join(dir, "tmp/fetch-stats.json"),
      JSON.stringify({
        startedAt: "2026-10-01T07:17:00Z",
        elapsedSeconds: 12,
        ok: false,
        wfs: { requests: 3, retries: 2, responseBytes: 33 },
      }),
    );
    expect((await notes()).stdout).toContain("Fetch failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
