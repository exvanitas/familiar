#!/usr/bin/env node
// The fake MCP server as a program.
//   node src/main.ts                 over stdio, as a local server runs
//   node src/main.ts --http 0        over HTTP on 127.0.0.1 (0 picks a free port). Prints "READY <url>" when listening.
//   --variant b                      echo's description and behaviour change
// Its log goes to stderr. The crash tool exits with code 3.

import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { startHttp } from './http.ts';
import { createFakeServer, type Era, type Variant } from './server.ts';

const { values } = parseArgs({
  options: {
    http: { type: 'string' },
    variant: { type: 'string', default: 'a' },
    era: { type: 'string', default: 'legacy' }
  }
});

if (values.variant !== 'a' && values.variant !== 'b') {
  process.stderr.write('--variant must be a or b\n');
  process.exit(2);
}

const options = {
  variant: values.variant as Variant,
  era: values.era as Era,
  env: process.env,
  log: (line: string) => process.stderr.write(`${line}\n`),
  crash: () => process.exit(3),
  // A child that starts a grandchild and prints its id; the grandchild starts one more after 2 s,
  // after anyone listing the tree has listed it. All wait for ever, each with the token as its
  // last argument. None reads the server's stdin or writes to its stdout.
  spawnTree: (token: string) =>
    new Promise<{ server: number; child: number; grandchild: number }>((done, fail) => {
      const later = 'setInterval(() => {}, 1000)';
      const grandchild = `setTimeout(() => require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(later)}, process.argv[1]], { stdio: 'ignore' }), 2000); setInterval(() => {}, 1000)`;
      const child = `const g = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, process.argv[1]], { stdio: 'ignore' }); process.stdout.write(g.pid + '\\n'); setInterval(() => {}, 1000)`;
      const c = spawn(process.execPath, ['-e', child, token], { stdio: ['ignore', 'pipe', 'ignore'] });
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
  // stdio: one JSON-RPC message per line in, one per line out.
  const server = createFakeServer(options);
  const write = (m: object) => process.stdout.write(`${JSON.stringify(m)}\n`);
  createInterface({ input: process.stdin }).on('line', (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    void server.handle(message, write);
  });
  process.stdin.on('end', () => process.exit(0));
}
