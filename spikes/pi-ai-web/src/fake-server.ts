// A local HTTP server that replays the hand-written recordings. Paths are /<wire>/<scenario>/<anything the SDK adds>.
// It also serves static files under /page/ for the headless browser check, from the same origin.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { AddressInfo } from 'node:net';
import { recordings, type Scenario, type Wire } from './recordings.ts';

export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface FakeServer {
  readonly url: string;
  readonly requests: SeenRequest[];
  close(): Promise<void>;
}

const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key']);
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

export async function startFakeServer(options: { staticDir?: string } = {}): Promise<FakeServer> {
  const requests: SeenRequest[] = [];
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname.startsWith('/page/') && options.staticDir) {
      const file = normalize(join(options.staticDir, url.pathname.slice('/page/'.length)));
      if (!file.startsWith(options.staticDir)) return void res.writeHead(403).end();
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
      } catch {
        res.writeHead(404).end();
      }
      return;
    }

    const raw = await readBody(req);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = SECRET_HEADERS.has(k) ? '<redacted>' : String(v);
    }
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      // Keep the raw text.
    }
    requests.push({ method: req.method ?? '', path: url.pathname + url.search, headers, body });

    const [, wire, scenario] = url.pathname.split('/');
    const recording = recordings[wire as Wire]?.[scenario as Scenario];
    if (!recording) return void res.writeHead(404, { 'content-type': 'text/plain' }).end(`no recording for ${url.pathname}`);

    res.writeHead(recording.status, recording.headers);
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    for (const chunk of recording.chunks) {
      if (closed) return;
      res.write(chunk);
      if (recording.delayMs > 0) await new Promise((r) => setTimeout(r, recording.delayMs));
    }
    if (!closed) res.end();
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
