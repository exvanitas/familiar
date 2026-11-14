// The fake server over Streamable HTTP, as a remote server would be reached.
// Stateless: each request gets a fresh server, sharing one notes list. So a cancel sent as its own
// request can't reach a running call here. Cancelling is tested over stdio.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createFakeServer, type FakeServerOptions } from './server.ts';

export interface HttpHandle {
  /** The address to give a client, ending in /mcp. */
  readonly url: string;
  close(): Promise<void>;
}

export async function startHttp(options: FakeServerOptions & { readonly port?: number } = {}): Promise<HttpHandle> {
  const notes: string[] = [];
  let allowedHosts: string[] = [];

  const http = createServer((req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const server = createFakeServer({
      ...options,
      notes,
      // In-process there is no program to exit, so a crash drops every connection instead.
      crash: options.crash ?? (() => http.closeAllConnections())
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
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
