// A modern-only stdio server that ends its process after refusing the legacy opening (3.9): the pipe can
// close before the exe reports the exit. A write refused then is the pipe closing, and the start still asks
// for its one relaunch.
import { describe, expect, it } from 'vitest';
import { ServerLink, type Target } from '../../../src/mcp/wire/link.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import { realClock } from '../wire-fakes.ts';
import { LINK_LIMITS } from '../../../src/mcp/wire/link.ts';
import { mutations } from '../../../src/mutations.ts';

const local: Target = { where: 'local', setup: { id: 's1', label: 'S', program: 'node', args: [], cwd: '.', env: [], secrets: [] } };

/** A modern-only server: refuses the opening, then answers the modern list with `list` (or nothing), and
    exits `exitMs` later; `closeAfterInit` closes the pipe right after the opening. */
function modernOnly(list: 'refuse' | 'nothing', exitMs: number) {
  let emit!: (e: ProcessEvent) => void;
  const refusal = (id: unknown) => JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32022, message: 'x', data: { supported: ['2026-07-28'] } } });
  const port: ProcessPort = {
    async start(_s, on) {
      emit = on;
      return { run: 'p1' };
    },
    async write(_r, b) {
      const m = JSON.parse(new TextDecoder().decode(b));
      if (m.method === 'initialize') queueMicrotask(() => emit({ t: 'out', line: refusal(m.id) }));
      if (m.method === 'tools/list') {
        if (list === 'refuse') queueMicrotask(() => emit({ t: 'out', line: refusal(m.id) }));
        setTimeout(() => emit({ t: 'exit', code: 0 }), exitMs);
      }
    },
    async stop() {},
    async forget() {}
  };
  return port;
}

describe('a definitive refusal of the modern list', () => {
  it('a list answered -32022, then an exit: no relaunch, the answer decides', async () => {
    const link = new ServerLink('m', { processes: modernOnly('refuse', 20) }, realClock, { ended: () => {} });
    const r = await link.start(local, 'L');
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('relaunch');
  });

  it('the control: relaunching on an answer too (the named mutation) asks for one', async () => {
    mutations.set(['relaunch-on-answer']);
    try {
      const link = new ServerLink('m', { processes: modernOnly('refuse', 20) }, realClock, { ended: () => {} });
      expect(await link.start(local, 'L')).toMatchObject({ ok: false, relaunch: 'modern' });
    } finally {
      mutations.clear();
    }
  });
});

describe('a modern stdio refusal whose exit lags', () => {
  it('the control: without waiting for the lagging exit (the named mutation), no relaunch', async () => {
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
          setTimeout(() => emit({ t: 'exit', code: 0 }), 50);
        }
      },
      async stop() {},
      async forget() {}
    };
    mutations.set(['relaunch-races-exit']);
    try {
      const link = new ServerLink('m', { processes: port }, realClock, { ended: () => {} });
      const r = await link.start(local, 'L');
      expect(r.ok).toBe(false);
      expect(r).not.toHaveProperty('relaunch');
      expect(mutations.hits('relaunch-races-exit')).toBeGreaterThan(0);
    } finally {
      mutations.clear();
    }
  });

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

describe('a server that stops reading after refusing', () => {
  it("the write bound ends the run, which isn't an exit: no relaunch", async () => {
    let emit!: (e: ProcessEvent) => void;
    const port: ProcessPort = {
      async start(_s, on) {
        emit = on;
        return { run: 'p1' };
      },
      async write(_r, b) {
        const m = JSON.parse(new TextDecoder().decode(b));
        if (m.method === 'initialize') {
          queueMicrotask(() => emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32022, message: 'x', data: { supported: ['2026-07-28'] } } }) }));
          return;
        }
        // The modern list's write never ends: the server stopped reading; it never exits.
        await new Promise<void>(() => {});
      },
      // As the exe does after killing the job: the stop emits the process's exit a little later.
      async stop() {
        setTimeout(() => emit({ t: 'exit', code: null }), 25);
      },
      async forget() {}
    };
    const run = async () => new ServerLink('m', { processes: port }, realClock, { ended: () => {} }, { ...LINK_LIMITS, writeMs: 30 }).start(local, 'L');
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('relaunch');
    // The control: the end's cause forgotten, the exit Familiar caused reads as the server's own.
    mutations.set(['relaunch-after-kill']);
    try {
      expect(await run()).toMatchObject({ ok: false, relaunch: 'modern' });
    } finally {
      mutations.clear();
    }
  }, 10_000);
});

describe('a modern list answered, but not with a list Familiar can use, then an exit', () => {
  /** The opening refused, then the list answered with `result`, and an exit 20 ms later. */
  const answered = (result: (id: unknown) => unknown): ProcessPort => {
    let emit!: (e: ProcessEvent) => void;
    return {
      async start(_s, on) {
        emit = on;
        return { run: 'p1' };
      },
      async write(_r, b) {
        const m = JSON.parse(new TextDecoder().decode(b));
        if (m.method === 'initialize') queueMicrotask(() => emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32022, message: 'x', data: { supported: ['2026-07-28'] } } }) }));
        if (m.method === 'tools/list') {
          queueMicrotask(() => emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: m.id, result: result(m.id) }) }));
          setTimeout(() => emit({ t: 'exit', code: 0 }), 20);
        }
      },
      async stop() {},
      async forget() {}
    };
  };
  const tools = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `t${i}`, inputSchema: { type: 'object', properties: {} } }));
  for (const [name, result] of [
    ['a malformed list', () => ({ resultType: 'complete', tools: 'invalid' })],
    ['a catalog past its bound', () => ({ resultType: 'complete', tools: tools(200) })]
  ] as const)
    it(`${name}: the answer is the server's word, so no relaunch`, async () => {
      const link = new ServerLink('m', { processes: answered(result) }, realClock, { ended: () => {} });
      const r = await link.start(local, 'L');
      expect(r.ok).toBe(false);
      expect(r).not.toHaveProperty('relaunch');
    });
});
