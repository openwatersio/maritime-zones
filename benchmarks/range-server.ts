import { open } from "node:fs/promises";
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
    let file;
    try {
      file = await open(join(dir, req.url!.slice(1)));
    } catch {
      return void res.writeHead(404).end();
    }
    try {
      // Read only the span: this runs in the measured process, so a whole-file read per request would count against the query.
      const { size } = await file.stat();
      const start = range[1] ? Number(range[1]) : size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      const bytes = Buffer.alloc(end - start + 1);
      await file.read(bytes, 0, bytes.length, start);
      requests++;
      res.writeHead(206, { "Content-Length": bytes.length, "Content-Range": `bytes ${start}-${end}/${size}` });
      res.end(bytes);
    } finally {
      await file.close();
    }
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
