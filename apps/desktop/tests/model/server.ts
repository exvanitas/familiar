/* A local endpoint that replays shell-check/model-recordings.ts, for the Node tests. Paths are
   /<wire>/<scenario>/<whatever the SDK adds>. It keeps every request it saw, with key headers
   replaced by a note of what they held. */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { answer, keyOf } from '../../shell-check/model-recordings.ts';

export interface Seen {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** The key the request carried, as the endpoint read it. */
  readonly key: string;
}

export interface ModelServer {
  readonly url: string;
  readonly seen: Seen[];
  close(): Promise<void>;
}

const read = (req: IncomingMessage) =>
  new Promise<string>((done, fail) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => done(Buffer.concat(parts).toString('utf8')));
    req.on('error', fail);
  });

export async function startModelServer(extra?: (path: string) => { status: number; body: string } | undefined): Promise<ModelServer> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const body = await read(req);
      const path = (req.url ?? '/').split('?')[0]!;
      const key = keyOf(req.headers);
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      seen.push({ method: req.method ?? '', path: req.url ?? '/', headers, body, key });
      const own = extra?.(path);
      if (own) return void res.writeHead(own.status, { 'content-type': 'application/json' }).end(own.body);
      const r = answer(path, body, key);
      if (!r) return void res.writeHead(404, { 'content-type': 'text/plain' }).end(`no recording for ${path}`);
      res.writeHead(r.status, r.headers);
      let closed = false;
      res.on('close', () => { closed = true; });
      for (const [i, chunk] of r.chunks.entries()) {
        if (closed) return;
        if (r.stall && i === r.stall.after) await new Promise(done => setTimeout(done, r.stall!.ms));
        if (closed) return;
        res.write(chunk);
        if (r.delayMs > 0) await new Promise(done => setTimeout(done, r.delayMs));
      }
      if (!closed) res.end();
    })().catch(e => { res.statusCode = 500; res.end(String(e)); });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); })
  };
}
