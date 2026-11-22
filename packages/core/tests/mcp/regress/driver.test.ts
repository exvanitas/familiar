// The driver decides nothing (docs/mcp-design.md 5.4, pass 5 Track D): a refused action changes nothing,
// the owner's reservation is bound to its action, a port that throws or calls back synchronously meets the
// same events as one that doesn't, and Test's report is its own run's.
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../../src/mcp/client.ts';
import { mintDecision } from '../../../src/mcp/decision.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import { mutations } from '../../../src/mutations.ts';
import { memorySettingsStore } from '../../../src/settings/store.ts';
import { testPaths, REPO } from '../fake.ts';
import { initResult, listResult, realClock, textResult } from '../wire-fakes.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const setup = { kind: 'local' as const, id: 'l1', label: 'L', program: process.execPath, args: ['x.js'], cwd: REPO, env: [], secrets: [] };
const refusal = (id: unknown) => JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32022, message: 'x', data: { supported: ['2026-07-28'] } } });
const open = (processes: ProcessPort, extra: Record<string, unknown> = {}) => McpClient.open({ store: memorySettingsStore(), processes, net: {} as never, addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: realClock, paths: testPaths, ...extra } as Parameters<typeof McpClient.open>[0]);

/** A local server answering at once; `hook` sees each message first and may take it over. */
function server(hook: (m: any, emit: (e: ProcessEvent) => void, run: string) => boolean | void = () => {}) {
  const emits = new Map<string, (e: ProcessEvent) => void>();
  let starts = 0;
  const writes: string[] = [];
  const port: ProcessPort = {
    async start(_s, on) {
      const run = `p${++starts}`;
      emits.set(run, on);
      return { run };
    },
    async write(run, b) {
      const m = JSON.parse(new TextDecoder().decode(b));
      writes.push(`${run}:${m.method ?? 'reply'}`);
      const emit = emits.get(run)!;
      if (hook(m, emit, run)) return;
      queueMicrotask(() => {
        if (m.method === 'initialize') emit({ t: 'out', line: JSON.stringify(initResult(m.id)) });
        if (m.method === 'tools/list') emit({ t: 'out', line: JSON.stringify(listResult(m.id, ['look'])) });
        if (m.method === 'tools/call') emit({ t: 'out', line: JSON.stringify(textResult(m.id, 'ok')) });
      });
    },
    async stop(run) {
      queueMicrotask(() => emits.get(run)!({ t: 'exit', code: 0 }));
    },
    async forget() {}
  };
  return { port, emits, writes, starts: () => starts };
}

describe('a refused action changes nothing', () => {
  it('a manual Start refused during an automatic one leaves the run automatic: turned off, its relaunch never launches', async () => {
    let listed = false;
    const s = server((m, emit, run) => {
      if (m.method === 'initialize') {
        queueMicrotask(() => emit({ t: 'out', line: refusal(m.id) }));
        return true;
      }
      if (m.method === 'tools/list' && run === 'p1') {
        listed = true;
        return true;
      }
    });
    const client = await open(s.port);
    await client.add({ setup, problems: [] });
    await client.setEnabled('l1', true);
    const auto = client.startEnabled();
    for (let i = 0; i < 200 && !listed; i++) await sleep(2);
    expect(await client.start('l1')).toEqual({ kind: 'refused', words: 'It is starting.' });
    await client.setEnabled('l1', false);
    s.emits.get('p1')!({ t: 'exit', code: 0 });
    await Promise.race([auto, sleep(1000)]);
    expect(s.starts()).toBe(1);
    expect(client.get('l1')?.phase).toBe('stopped');
  });
});

describe("the owner's reservation is the action's", () => {
  it('a Start from inside the failure callback, then a Settings write: the start holds the owner, and the write is refused', async () => {
    const s = server();
    let fail = true;
    const base = s.port.start.bind(s.port);
    s.port.start = async (st, on) => {
      if (fail) {
        fail = false;
        throw Object.assign(new Error('declined'), { kind: 'declined' });
      }
      return base(st, on);
    };
    let client!: McpClient;
    let settings: Promise<string> | undefined;
    client = await open(s.port, {
      onChange: () => {
        if (settings || client.get('l1')?.phase !== 'failed') return;
        void client.start('l1');
        settings = client.setEnabled('l1', true).then(
          () => 'saved',
          (e: Error) => e.message
        );
      }
    });
    await client.add({ setup, problems: [] });
    await client.start('l1');
    await sleep(50);
    expect(await settings).toMatch(/Saving another change/);
    expect(client.get('l1')?.phase).toBe('ready');
  });
});

describe('a port that throws, or calls back, from inside its own call', () => {
  it('a process port whose start throws synchronously: Start fails, and the owner is free', async () => {
    const s = server();
    s.port.start = (() => {
      throw Object.assign(new Error('boom'), { kind: 'failed' });
    }) as unknown as ProcessPort['start'];
    const client = await open(s.port);
    await client.add({ setup, problems: [] });
    const r = await Promise.race([client.start('l1').then((x) => x, (e: Error) => ({ kind: 'rejected', words: e.message })), sleep(2000).then(() => 'hung' as const)]);
    expect(r).toMatchObject({ kind: 'failed' });
    expect(client.owner.busy).toBe(false);
    await expect(client.setEnabled('l1', false)).resolves.toBeUndefined();
  });

  for (const mutation of [undefined, 'busy-after-handoff'] as const)
    it(`a port that delivers an exit from inside write(): the call is interrupted, nothing throws${mutation ? ` (control: ${mutation} shows the machine Idle inside the port's call)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        let inside: string | undefined;
        let armed = false;
        const s = server();
        const asyncWrite = s.port.write;
        let client!: McpClient;
        s.port.write = ((run: string, b: Uint8Array) => {
          const m = JSON.parse(new TextDecoder().decode(b));
          if (m.method === 'tools/call' && armed) {
            inside = (client as any).runtimes.get('l1').link.state.slot;
            s.emits.get(run)!({ t: 'exit', code: 1 });
            return Promise.resolve();
          }
          return asyncWrite(run, b);
        }) as ProcessPort['write'];
        client = await open(s.port);
        await client.add({ setup, problems: [] });
        await client.start('l1');
        armed = true;
        const out = await client.send(mintDecision(client.facts('l1', 'look', {})!, 't1', 'asked'), new AbortController().signal);
        if (mutation) {
          expect(inside).toBe('idle');
          return;
        }
        expect(inside).toBe('busy');
        expect(out).toEqual({ kind: 'interrupted' });
        const link = (client as any).runtimes.get('l1').link;
        expect(link.state.slot).toBe('idle');
        expect(link.busy).toBe(false);
      } finally {
        mutations.clear();
      }
    });
});

describe("a Test's report outlives no run (r35b #10)", () => {
  for (const mutation of [undefined, 'report-kept-after-run'] as const)
  it(`three Tests that publish and then fail (their first write refused) leave no report behind${mutation ? ` (control: ${mutation} keeps all three)` : ''}`, async () => {
    mutations.set(mutation ? [mutation] : []);
    try {
    const s = server();
    const base = memorySettingsStore();
    let refuse = false;
    const store = { ...base, putIf: async (k: string, r: any, g: any) => (refuse ? false : base.putIf(k, r, g)) } as typeof base;
    const client = await open(s.port, { store });
    await client.add({ setup, problems: [] });
    refuse = true;
    for (let i = 0; i < 3; i++) expect((await client.test('l1')).ok).toBe(false);
    const link = (client as any).runtimes.get('l1').link;
    if (mutation) {
      expect(link.reports.size).toBe(3);
      return;
    }
    expect(link.reports.size).toBe(0);
    refuse = false;
    const ok = await client.test('l1');
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.tools.length).toBe(1);
    expect(link.reports.size).toBe(0);
    expect(link.delivered.size).toBe(0);
    } finally {
      mutations.clear();
    }
  });
});

describe("a refused Test never takes a passing Test's report (r36 #6)", () => {
  it('a second Test, refused during the first one\'s cleanup, then the exit in the same task: the first gets its tools', async () => {
    const s = server();
    let exit: (() => void) | undefined;
    s.port.stop = (async (run: string) => {
      exit = () => s.emits.get(run)!({ t: 'exit', code: 0 });
    }) as ProcessPort['stop'];
    const client = await open(s.port);
    await client.add({ setup, problems: [] });
    const first = client.test('l1');
    for (let i = 0; i < 200 && !exit; i++) await sleep(2);
    expect(exit).toBeDefined();
    const second = client.test('l1');
    exit!();
    const [a, b] = await Promise.all([first, second]);
    expect(b.ok).toBe(false);
    expect(a.ok).toBe(true);
    expect(a.ok && a.tools.length).toBe(1);
  });
});

describe('an idle pong whose write delivers the exit (r35b #5)', () => {
  for (const mutation of [undefined, 'pong-busy-after-handoff'] as const)
    it(`both machines are Idle after it, and the next Start reaches its new process${mutation ? ` (control: ${mutation} leaves the lifecycle busy)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        let armed = false;
        const s = server();
        const asyncWrite = s.port.write;
        s.port.write = ((run: string, b: Uint8Array) => {
          const m = JSON.parse(new TextDecoder().decode(b));
          // The pong: a reply to the server's ping, with no method.
          if (armed && m.method === undefined && m.id === 'ping-1') {
            armed = false;
            s.emits.get(run)!({ t: 'exit', code: 1 });
            return Promise.resolve();
          }
          return asyncWrite(run, b);
        }) as ProcessPort['write'];
        const client = await open(s.port);
        await client.add({ setup, problems: [] });
        expect((await client.start('l1')).kind).toBe('ready');
        armed = true;
        s.emits.get('p1')!({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: 'ping-1', method: 'ping' }) });
        await sleep(30);
        const link = (client as any).runtimes.get('l1').link;
        if (mutation) {
          expect(link.state.slot).toBe('busy');
          return;
        }
        expect(link.state.slot).toBe('idle');
        expect(link.busy).toBe(false);
        const again = await Promise.race([client.start('l1'), sleep(3000).then(() => ({ kind: 'hung' }))]);
        expect(again).toMatchObject({ kind: 'ready' });
        expect(s.writes).toContain('p2:initialize');
        await client.stop('l1');
      } finally {
        mutations.clear();
      }
    });
});

describe("a modern server's era refusal on a call", () => {
  for (const mutation of [undefined, 'era-refusal-late'] as const)
    it(`ends the run in the call's own terminal step: a second send right after reaches nothing${mutation ? ` (control: ${mutation} lets it through)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        let deliver: (() => void) | undefined;
        const s = server((m, emit) => {
          if (m.method === 'initialize') {
            queueMicrotask(() => emit({ t: 'out', line: refusal(m.id) }));
            return true;
          }
          if (m.method === 'tools/list') {
            queueMicrotask(() => emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', tools: [{ name: 'look', description: 'look', inputSchema: { type: 'object', properties: {} } }] } }) }));
            return true;
          }
          if (m.method === 'tools/call') {
            deliver = () => emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32022, message: 'x', data: { supported: ['2027-01-01'] } } }) });
            return true;
          }
        });
        const client = await open(s.port);
        await client.add({ setup, problems: [] });
        expect((await client.start('l1')).kind).toBe('ready');
        const send = () => client.send(mintDecision(client.facts('l1', 'look', {})!, `t${Math.random()}`, 'asked'), new AbortController().signal);
        const a = send();
        for (let i = 0; i < 50 && !deliver; i++) await sleep(2);
        let b: ReturnType<typeof send> | undefined;
        queueMicrotask(() => {
          b = send();
        });
        deliver!();
        expect(await a).toEqual({ kind: 'interrupted' });
        await b;
        expect(s.writes.filter((w) => w.endsWith('tools/call')).length).toBe(mutation ? 2 : 1);
      } finally {
        mutations.clear();
      }
    });
});

describe("Test's report is its own run's", () => {
  it('a Start the moment Test reaches Stopped: the report still lists the tools Test saw', async () => {
    const s = server();
    let client!: McpClient;
    let started = false;
    client = await open(s.port, {
      onChange: () => {
        if (!started && client.get('l1')?.phase === 'stopped' && s.starts() === 1) {
          started = true;
          void client.start('l1');
        }
      }
    });
    await client.add({ setup, problems: [] });
    const r = await client.test('l1');
    expect(started).toBe(true);
    expect(r).toMatchObject({ ok: true, tools: [{ name: 'look' }] });
  });
});

describe('the test-only refresh', () => {
  it('leaves no timer behind', async () => {
    const s = server();
    const client = await open(s.port);
    await client.add({ setup, problems: [] });
    await client.start('l1');
    const link = (client as any).runtimes.get('l1').link;
    const timers = () => (process as any).getActiveResourcesInfo().filter((x: string) => x === 'Timeout').length;
    const before = timers();
    for (let i = 0; i < 20; i++) await link.list();
    await sleep(20);
    expect(timers()).toBeLessThanOrEqual(before);
    expect(link.watchers.size).toBe(0);
    await client.stop('l1');
  });
});
