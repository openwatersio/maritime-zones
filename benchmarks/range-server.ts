import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/** Serves a directory of tiles the way GitHub Pages does: byte ranges only, 206 with Content-Range. */
export async function serveRanges(dir: string) {
  let requests = 0;
  const server = createServer(async (req, res) => {
    if (!/^\/[ns]\d+[ew]\d+\.fgb\.zst$/.test(req.url!)) return void res.writeHead(404).end();
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (!range) return void res.writeHead(400).end();
    let file: Buffer;
    try {
      file = await readFile(join(dir, req.url!.slice(1)));
    } catch {
      return void res.writeHead(404).end();
    }
    const start = range[1] ? Number(range[1]) : file.length - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), file.length - 1) : file.length - 1;
    const bytes = file.subarray(start, end + 1);
    requests++;
    res.writeHead(206, { "Content-Length": bytes.length, "Content-Range": `bytes ${start}-${end}/${file.length}` });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    get requests() {
      return requests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
