// Test acts on its own run only (5.4): a failed catalog write stops the run it was for, a Stop during the
// write means Test reports no success, and Test never stops a run started since.
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../../src/mcp/client.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import type { ServerSetup } from '../../../src/mcp/setup.ts';
import { memorySettingsStore, type SettingsStore } from '../../../src/settings/store.ts';
import { mutations } from '../../../src/mutations.ts';
import { testPaths, REPO } from '../fake.ts';
import { fakeProcess, initResult, listResult, realClock } from '../wire-fakes.ts';

const local = (id: string): ServerSetup => ({ kind: 'local', id, label: `Files ${id}`, program: process.execPath, args: ['x.js'], cwd: REPO, env: [], secrets: [] });

/** Each start a fresh process that answers the handshake and lists `echo`; counts native starts and stops. */
function port() {
  const counts = { starts: 0, stops: 0 };
  const procs = new Map<string, ReturnType<typeof fakeProcess>>();
  const p: ProcessPort = {
    async start(setup, onEvent) {
      const fp = fakeProcess((msg) => (msg.method === 'initialize' ? [JSON.stringify(initResult(msg.id))] : msg.method === 'tools/list' ? [JSON.stringify(listResult(msg.id, ['echo']))] : []));
      const id = `${setup.id}-${++counts.starts}`;
      procs.set(id, fp);
      await fp.port.start(setup, onEvent);
      return { run: id };
    },
    async write(run, bytes) {
      return procs.get(run)!.port.write('p1', bytes);
    },
    async stop(run) {
      counts.stops++;
      return procs.get(run)!.port.stop('p1');
    },
    async forget() {}
  };
  return { port: p, counts };
}

const open = (store: SettingsStore, processes: ProcessPort) =>
  McpClient.open({ store, processes, net: {} as never, addresses: { add: async () => ({ id: 'addr-1' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: realClock, paths: testPaths });

describe("Test and its catalog write", () => {
  it('a catalog write that fails: Test reports the failure, and the server it started is stopped', async () => {
    const store = memorySettingsStore();
    const { port: p, counts } = port();
    const client = await open(store, p);
    await client.add({ setup: local('l1'), problems: [] });
    // From here every write of the record fails, as a full disk would.
    const failing: SettingsStore = { ...store, put: async () => Promise.reject(new Error('quota')), putIf: async () => Promise.reject(new Error('quota')) };
    const two = await open(failing, p);
    const r = await two.test('l1');
    expect(r.ok).toBe(false);
    expect(two.get('l1')!.phase).not.toBe('ready');
    expect(counts.stops).toBe(counts.starts);
  });
});

describe("Test's settle acts on its own start only", () => {
  const scenario = async () => {
    const store = memorySettingsStore();
    let starts = 0;
    const inner = port();
    const p: ProcessPort = {
      ...inner.port,
      async start(setup, onEvent) {
        // The first start is Test's; the second, Start B's, is refused by the exe.
        if (++starts === 2) throw Object.assign(new Error('declined'), { kind: 'declined' });
        return inner.port.start(setup, onEvent);
      }
    };
    const first = await open(store, p);
    await first.add({ setup: local('l1'), problems: [] });
    // Test's catalog write is held until Stop has answered; then it lands.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let hold = true;
    const slow: SettingsStore = { ...store, putIf: async (k, r, g) => (hold ? ((hold = false), await held) : undefined, store.putIf(k, r, g)) };
    const client = await open(slow, p);
    const testing = client.test('l1');
    for (let i = 0; i < 200 && client.get('l1')!.phase !== 'ready'; i++) await new Promise((r) => setTimeout(r, 5));
    expect((await client.stop('l1')).kind).toBe('stopped');
    // Start B, in the same step as the owner's release, before Test's own continuation runs.
    let b: Promise<unknown> | undefined;
    const off = client.owner.onChange(() => {
      if (b || client.owner.busy) return;
      b = client.start('l1');
    });
    release();
    const report = await testing;
    await b;
    off();
    expect(report.ok).toBe(false);
    return client.get('l1')!;
  };
  it("a Start admitted at the owner's release, whose native start fails, keeps its failure after a stale Test settles", async () => {
    const s = await scenario();
    expect(s.phase).toBe('failed');
    expect(s.failure?.kind).toBe('declined');
  });
  it('the control: a settle with no token (stale-settle) clears that failure', async () => {
    mutations.set(['stale-settle']);
    try {
      expect((await scenario()).phase).toBe('stopped');
    } finally {
      mutations.clear();
    }
  });
});

describe("a crash during Test's catalog write (shadow r32 F05)", () => {
  it("Test reports the crash in its own words, not that the server was stopped", async () => {
    const store = memorySettingsStore();
    let emit!: (e: ProcessEvent) => void;
    const p: ProcessPort = {
      async start(_s, on) {
        emit = on;
        return { run: 'p1' };
      },
      async write(_r, b) {
        const m = JSON.parse(new TextDecoder().decode(b));
        queueMicrotask(() => {
          if (m.method === 'initialize') emit({ t: 'out', line: JSON.stringify(initResult(m.id)) });
          if (m.method === 'tools/list') emit({ t: 'out', line: JSON.stringify(listResult(m.id, ['echo'])) });
        });
      },
      async stop() {
        queueMicrotask(() => emit({ t: 'exit', code: 0 }));
      },
      async forget() {}
    };
    const first = await open(store, p);
    await first.add({ setup: local('l1'), problems: [] });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let hold = true;
    const slow: SettingsStore = { ...store, putIf: async (k, r, g) => (hold ? ((hold = false), await held) : undefined, store.putIf(k, r, g)) };
    const client = await open(slow, p);
    const testing = client.test('l1');
    for (let i = 0; i < 200 && client.get('l1')!.phase !== 'ready'; i++) await new Promise((r) => setTimeout(r, 5));
    // The server crashes while Test's catalog write is saving.
    emit({ t: 'err', line: 'boom: out of memory' });
    emit({ t: 'exit', code: 3 });
    release();
    const report = await testing;
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.failure.words).not.toMatch(/stopped before it was ready/);
    expect(report.failure.lastOutput ?? report.failure.words).toMatch(/boom|exited|code 3/);
  });
});
