// A modern-only stdio server that ends its process after refusing the legacy opening (3.9): the pipe can
// close before the exe reports the exit. A write refused then is the pipe closing, and the start still asks
// for its one relaunch.
import { describe, expect, it } from 'vitest';
import { ServerLink, type Target } from '../../../src/mcp/wire/link.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import { realClock } from '../wire-fakes.ts';

const local: Target = { where: 'local', setup: { id: 's1', label: 'S', program: 'node', args: [], cwd: '.', env: [], secrets: [] } };

describe('a modern stdio refusal whose exit lags', () => {
  it('a refused write before the exit still gives one relaunch', async () => {
    let emit!: (e: ProcessEvent) => void;
    let closed = false;
    const port: ProcessPort = {
      async start(_s, on) {
        emit = on;
        return { run: 'p1' };
      },
      async write(_r, b) {
        if (closed) throw Object.assign(new Error('broken pipe'), { kind: 'not-running' });
        const m = JSON.parse(new TextDecoder().decode(b));
        if (m.method === 'initialize') {
          queueMicrotask(() => emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32022, message: 'x', data: { supported: ['2026-07-28'] } } }) }));
          closed = true;
          // The exit is reported a while after the pipe closed.
          setTimeout(() => emit({ t: 'exit', code: 0 }), 50);
        }
      },
      async stop() {},
      async forget() {}
    };
    const link = new ServerLink('m', { processes: port }, realClock, { ended: () => {} });
    expect(await link.start(local, 'L')).toMatchObject({ ok: false, relaunch: 'modern' });
  });
});
