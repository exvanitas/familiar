// A start answers Ready only once its last exchange has drained (docs/mcp-design.md 3.4, 5.4): a call made
// the moment Start answers is admitted, never refused busy because the list's write is still unacknowledged.
import { describe, expect, it } from 'vitest';
import { ServerLink, type Target } from '../../../src/mcp/wire/link.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import { initResult, listResult, realClock, textResult } from '../wire-fakes.ts';

const local: Target = { where: 'local', setup: { id: 's1', label: 'S', program: 'node', args: [], cwd: '.', env: [], secrets: [] } };

/** A process port whose server answers at once, while the exe acknowledges each write a tick later. */
function lateAcks(): ProcessPort {
  let emit!: (e: ProcessEvent) => void;
  return {
    async start(_s, on) {
      emit = on;
      return { run: 'p1' };
    },
    async write(_r, b) {
      const m = JSON.parse(new TextDecoder().decode(b));
      queueMicrotask(() => {
        if (m.method === 'initialize') emit({ t: 'out', line: JSON.stringify(initResult(m.id)) });
        if (m.method === 'tools/list') emit({ t: 'out', line: JSON.stringify(listResult(m.id, ['look'])) });
        if (m.method === 'tools/call') emit({ t: 'out', line: JSON.stringify(textResult(m.id, 'seen')) });
      });
      await new Promise<void>((r) => setTimeout(r, 5));
    },
    async stop() {
      queueMicrotask(() => emit({ t: 'exit', code: 0 }));
    },
    async forget() {}
  };
}

describe('Start and the last exchange\'s drain', () => {
  it('a call made the moment Start answers Ready is admitted and answered', async () => {
    const link = new ServerLink('s', { processes: lateAcks() }, realClock, { ended: () => {} });
    const r = await link.start(local, 'L');
    expect(r.ok).toBe(true);
    const call = link.handoff('look', '{}', new AbortController().signal, 5_000);
    expect(call).toBeDefined();
    expect(await call).toEqual({ kind: 'result', text: 'seen', isError: false });
    await link.stop();
  });

  it('a start whose drain outlasts its deadline answers timed out, not Ready', async () => {
    let emit!: (e: ProcessEvent) => void;
    const port: ProcessPort = {
      async start(_s, on) {
        emit = on;
        return { run: 'p1' };
      },
      async write(_r, b) {
        const m = JSON.parse(new TextDecoder().decode(b));
        queueMicrotask(() => {
          if (m.method === 'initialize') emit({ t: 'out', line: JSON.stringify(initResult(m.id)) });
          if (m.method === 'tools/list') emit({ t: 'out', line: JSON.stringify(listResult(m.id, ['look'])) });
        });
        // The list's write is never acknowledged.
        if (m.method === 'tools/list') await new Promise<void>(() => {});
      },
      async stop() {
        queueMicrotask(() => emit({ t: 'exit', code: 0 }));
      },
      async forget() {}
    };
    const link = new ServerLink('s', { processes: port }, realClock, { ended: () => {} }, { startMs: 200, listMs: 200, pongMs: 100, headersMs: 1000, idleMs: 1000, writeMs: 60_000, stopMs: 10_000, graceMs: 2_000 });
    const r = await link.start(local, 'L');
    expect(r).toMatchObject({ ok: false, failure: { kind: 'timed-out' } });
  });
});
