// A list_changed refresh waits for the slot like any administrative exchange (3.5, 3.7): an idle ping that
// takes the slot between the call's drain and the refresh doesn't drop the refresh, and the catalog doesn't
// stay stale, refusing every call.
import { describe, expect, it } from 'vitest';
import { ServerLink, type Target } from '../../../src/mcp/wire/link.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import { mutations } from '../../../src/mutations.ts';
import { initResult, listResult, realClock, textResult } from '../wire-fakes.ts';

const local: Target = { where: 'local', setup: { id: 's1', label: 'S', program: 'node', args: [], cwd: '.', env: [], secrets: [] } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function scenario() {
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
        if (m.method === 'tools/call') {
          emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) });
          emit({ t: 'out', line: JSON.stringify(textResult(m.id, 'seen')) });
        }
      });
    },
    async stop() {
      queueMicrotask(() => emit({ t: 'exit', code: 0 }));
    },
    async forget() {}
  };
  const link = new ServerLink('s', { processes: port }, realClock, { ended: () => {} });
  expect((await link.start(local, 'L')).ok).toBe(true);
  const call = link.handoff('look', '{}', new AbortController().signal, 5_000)!;
  // An idle ping, delivered the moment the call's exchange drains: before the refresh can take the slot.
  void link.drained().then(() => emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: 'i1', method: 'ping' }) }));
  expect(await call).toMatchObject({ kind: 'result' });
  for (let i = 0; i < 100 && link.current?.stale; i++) await sleep(10);
  const stale = link.current?.stale;
  const again = link.handoff('look', '{}', new AbortController().signal, 5_000);
  const out = again ? await again : undefined;
  await link.stop();
  return { stale, out };
}

describe('a list_changed refresh and an idle ping', () => {
  it('the ping between the drain and the refresh: the refresh still runs, and the next call goes out', async () => {
    const r = await scenario();
    expect(r.stale).toBe(false);
    expect(r.out).toMatchObject({ kind: 'result', text: 'seen' });
  });

  it('the control: the refresh through the public list(), which answers busy (refresh-through-list), stays stale', async () => {
    mutations.set(['refresh-through-list']);
    try {
      expect((await scenario()).stale).toBe(true);
    } finally {
      mutations.clear();
    }
  });
});
