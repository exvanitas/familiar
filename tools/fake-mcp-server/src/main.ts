#!/usr/bin/env node
// The fake MCP server as a program.
//   node src/main.ts                 over stdio, as a local server runs
//   node src/main.ts --http 0        over HTTP on 127.0.0.1 (0 picks a free port). Prints "READY <url>" when listening.
//   --variant b                      echo's description and behaviour change
// Its log goes to stderr. The crash tool exits with code 3.

import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startHttp } from './http.ts';
import { createFakeServer, type Variant } from './server.ts';

const { values } = parseArgs({
  options: {
    http: { type: 'string' },
    variant: { type: 'string', default: 'a' }
  }
});

if (values.variant !== 'a' && values.variant !== 'b') {
  process.stderr.write('--variant must be a or b\n');
  process.exit(2);
}

const options = {
  variant: values.variant as Variant,
  env: process.env,
  log: (line: string) => process.stderr.write(`${line}\n`),
  crash: () => process.exit(3)
};

if (values.http !== undefined) {
  const port = Number(values.http);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write('--http takes a port number, or 0 for a free one\n');
    process.exit(2);
  }
  const handle = await startHttp({ ...options, port });
  process.stdout.write(`READY ${handle.url}\n`);
} else {
  await createFakeServer(options).connect(new StdioServerTransport());
}
