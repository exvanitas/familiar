#!/usr/bin/env node
// The fake MCP server as a program.
//   node src/main.ts                 over stdio, as a local server runs
//   node src/main.ts --http 0        over HTTP on 127.0.0.1 (0 picks a free port). Prints "READY <url>" when listening.
//   --variant b                      echo's description and behaviour change
// Its log goes to stderr. The crash tool exits with code 3.

import { spawn } from 'node:child_process';
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
  crash: () => process.exit(3),
  // A child that starts a grandchild and prints its id, both waiting for ever. Neither reads the
  // server's stdin or writes to its stdout.
  spawnTree: () =>
    new Promise<{ server: number; child: number; grandchild: number }>((done, fail) => {
      const grandchild = 'setInterval(() => {}, 1000)';
      const child = `const g = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); process.stdout.write(g.pid + '\\n'); setInterval(() => {}, 1000)`;
      const c = spawn(process.execPath, ['-e', child], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      c.stdout.on('data', (b: Buffer) => {
        out += b.toString();
        const line = out.split('\n')[0].trim();
        if (out.includes('\n') && line) done({ server: process.pid, child: c.pid ?? 0, grandchild: Number(line) });
      });
      c.on('error', fail);
    })
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
