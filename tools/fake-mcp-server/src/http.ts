// The fake server over Streamable HTTP, as a remote server would be reached. Stateless: each POST is one
// message, and every connection shares one notes list and one variant. A request's answer is one JSON body,
// or an event stream when the server says something before it (list_changed); a notification gets 202.
// GET and DELETE get 405. Only its own host is accepted (DNS rebinding).

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFakeServer, type FakeServerOptions } from './server.ts';

export interface HttpHandle {
  /** The address to give a client, ending in /mcp. */
  readonly url: string;
  close(): Promise<void>;
}

export async function startHttp(options: FakeServerOptions & { readonly port?: number } = {}): Promise<HttpHandle> {
  const notes: string[] = [];
  const shared = { variant: options.variant ?? 'a' };
  let allowedHosts: string[] = [];
  let http: ReturnType<typeof createServer>;
  const server = createFakeServer({ ...options, notes, shared, crash: options.crash ?? (() => http.closeAllConnections()) });

  http = createServer((req, res) => {
    if (req.url !== '/mcp') return void res.writeHead(404).end();
    if (!allowedHosts.includes(req.headers.host ?? '')) return void res.writeHead(403).end();
    if (req.method !== 'POST') return void res.writeHead(405, { Allow: 'POST' }).end();
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      let message: any;
      try {
        message = JSON.parse(body);
      } catch {
        return void res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      }
      if (message?.id === undefined) {
        void server.handle(message, () => {});
        return void res.writeHead(202).end();
      }
      const out: object[] = [];
      server.handle(message, (m) => out.push(m)).then(() => {
        if (res.destroyed) return;
        if (out.length === 1) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out[0]));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(out.map((m) => `data: ${JSON.stringify(m)}\n\n`).join(''));
      });
    });
  });

  await new Promise<void>((resolve) => http.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      })
  };
}
