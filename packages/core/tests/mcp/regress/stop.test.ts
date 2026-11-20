// Stop, against a native start still under way and against a live local exchange (3.4, 3.11, 5.4).
import { describe, expect, it } from 'vitest';
import { ServerLink, type Target } from '../../../src/mcp/wire/link.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import { initResult, listResult, realClock } from '../wire-fakes.ts';
import { mutations } from '../../../src/mutations.ts';

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
        // The exit comes later, on its own timer, never in the stop's own step.
        setTimeout(() => emits.get(run)!({ t: 'exit', code: 0 }), 20);
      },
      async forget() {}
    };
    const link = new ServerLink('s', { processes: port }, realClock, { ended: () => {} });
    const started = link.start(local, 'L');
    await sleep(5);
    let stopped = false;
    const stopping = link.stop().then(() => (stopped = true));
    await sleep(10);
    // Stop waits out the pending native start: nothing is stopped yet, and Stop hasn't answered.
    expect(stopped).toBe(false);
    held = false;
    release();
    await sleep(5);
    expect(stops).toEqual(['p9']);
    expect(stopped).toBe(false);
    await stopping;
    const r = await started;
    expect(r.ok).toBe(false);
    // One native stop, and the exit came before Stop answered.
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

describe('Stop during the handshake', () => {
  it('answers only after the exit, which comes on a later timer, with exactly one native stop', async () => {
    let emit!: (e: ProcessEvent) => void;
    const stops: string[] = [];
    let exited = false;
    const port: ProcessPort = {
      async start(_s, on) {
        emit = on;
        return { run: 'p1' };
      },
      // initialize is never answered: the handshake is under way when Stop comes.
      async write() {},
      async stop(run) {
        stops.push(run);
        setTimeout(() => {
          exited = true;
          emit({ t: 'exit', code: 0 });
        }, 30);
      },
      async forget() {}
    };
    const link = new ServerLink('s', { processes: port }, realClock, { ended: () => {} });
    const started = link.start(local, 'L');
    await sleep(5);
    await link.stop();
    expect(exited).toBe(true);
    expect((await started).ok).toBe(false);
    await sleep(40);
    expect(stops).toEqual(['p1']);
  });
});

describe('a Stop the exe refuses (shadow r32 F28, r32b #7)', () => {
  it('on a Ready local run: Stop answers, in words that say it may still be running, and the slot waits for the exit (stop-refused-waits hangs)', async () => {
   for (const mutation of [undefined, 'stop-refused-waits'] as const) {
    mutations.set(mutation ? [mutation] : []);
    try {
    const { McpClient } = await import('../../../src/mcp/client.ts');
    const { memorySettingsStore } = await import('../../../src/settings/store.ts');
    const { testPaths, REPO } = await import('../fake.ts');
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
      },
      async stop() {
        throw Object.assign(new Error('refused'), { kind: 'failed' });
      },
      async forget() {}
    };
    const client = await McpClient.open({ store: memorySettingsStore(), processes: port, net: {} as never, addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: realClock, paths: testPaths });
    await client.add({ setup: { kind: 'local', id: 'l1', label: 'L', program: process.execPath, args: ['x.js'], cwd: REPO, env: [], secrets: [] }, problems: [] });
    expect((await client.start('l1')).kind).toBe('ready');
    const answered = await Promise.race([client.stop('l1'), sleep(mutation ? 300 : 2_000).then(() => 'hung' as const)]);
    if (mutation) {
      // The control: Stop waits for a run's end that nothing brings.
      expect(answered).toBe('hung');
      emit({ t: 'exit', code: 0 });
      continue;
    }
    expect(answered).toMatchObject({ kind: 'failed', failure: { words: expect.stringMatching(/refused, so it may still be running/) } });
    expect(client.get('l1')!.phase).toBe('failed');
    // Nothing is admitted to the process while it may live: a Start is refused until it has exited.
    expect((await client.start('l1')).kind).not.toBe('ready');
    emit({ t: 'exit', code: 0 });
    await sleep(10);
    expect((await client.start('l1')).kind).toBe('ready');
    } finally {
      mutations.clear();
    }
   }
  });
});
