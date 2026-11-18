// Stop, against a native start still under way and against a live local exchange (3.4, 3.11, 5.4).
import { describe, expect, it } from 'vitest';
import { ServerLink, type Target } from '../../../src/mcp/wire/link.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import { initResult, listResult, realClock } from '../wire-fakes.ts';

const local: Target = { where: 'local', setup: { id: 's1', label: 'S', program: 'node', args: [], cwd: '.', env: [], secrets: [] } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('Stop during a native start', () => {
  it('stops the process the exe then starts, waits for its exit, and the next Start is admitted', async () => {
    let release!: () => void;
    const stops: string[] = [];
    const emits = new Map<string, (e: ProcessEvent) => void>();
    let held = true;
    const port: ProcessPort = {
      async start(_s, on) {
        const run = held ? 'p9' : 'p10';
        emits.set(run, on);
        if (held) await new Promise<void>((r) => (release = r));
        return { run };
      },
      async write(run, b) {
        const m = JSON.parse(new TextDecoder().decode(b));
        queueMicrotask(() => {
          if (m.method === 'initialize') emits.get(run)!({ t: 'out', line: JSON.stringify(initResult(m.id)) });
          if (m.method === 'tools/list') emits.get(run)!({ t: 'out', line: JSON.stringify(listResult(m.id, ['look'])) });
        });
      },
      async stop(run) {
        stops.push(run);
        queueMicrotask(() => emits.get(run)!({ t: 'exit', code: 0 }));
      },
      async forget() {}
    };
    const link = new ServerLink('s', { processes: port }, realClock, { ended: () => {} });
    const started = link.start(local, 'L');
    await sleep(5);
    await link.stop();
    held = false;
    release();
    const r = await started;
    expect(r.ok).toBe(false);
    expect(stops).toEqual(['p9']);
    // The exit was awaited before the start answered: the next Start is admitted at once.
    const again = await link.start(local, 'L');
    expect(again.ok).toBe(true);
  });
});

describe('Stop with a live local exchange', () => {
  it('ends the exchange in Stop\'s own step: no pong after it, and the call answers "interrupted"', async () => {
    let emit!: (e: ProcessEvent) => void;
    const writes: any[] = [];
    let exitNow!: () => void;
    const port: ProcessPort = {
      async start(_s, on) {
        emit = on;
        return { run: 'p1' };
      },
      async write(_r, b) {
        const m = JSON.parse(new TextDecoder().decode(b));
        writes.push(m);
        queueMicrotask(() => {
          if (m.method === 'initialize') emit({ t: 'out', line: JSON.stringify(initResult(m.id)) });
          if (m.method === 'tools/list') emit({ t: 'out', line: JSON.stringify(listResult(m.id, ['look'])) });
        });
      },
      async stop() {
        await new Promise<void>((r) => (exitNow = r));
      },
      async forget() {}
    };
    const link = new ServerLink('s', { processes: port }, realClock, { ended: () => {} });
    await link.start(local, 'L');
    const call = link.handoff('look', '{}', new AbortController().signal, 5000)!;
    await sleep(5);
    const callId = writes.find((w) => w.method === 'tools/call').id;
    const stopping = link.stop();
    await sleep(5);
    const before = writes.length;
    emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: 'pg', method: 'ping' }) });
    emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: callId, result: { content: [{ type: 'text', text: 'done' }] } }) });
    await sleep(5);
    expect(writes.slice(before)).toEqual([]);
    exitNow();
    emit({ t: 'exit', code: 0 });
    await stopping;
    expect((await call).kind).toBe('interrupted');
  });
});
