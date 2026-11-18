// The client over the owner, with fake ports: what a saved record holds, when a start may run, what a
// revoke and Mark reviewed save (docs/mcp-design.md 5.1, 5.4, 5.5).
import { describe, expect, it } from 'vitest';
import { BUILT_IN, McpClient, type McpClientOptions } from '../../src/mcp/client.ts';
import { choiceKey } from '../../src/mcp/server-tools.ts';
import { gateFor } from '../../src/journal/gate.ts';
import { Owner, OWNER_KEY, OWNER_VERSION, type OwnerPorts } from '../../src/mcp/owner.ts';
import type { ProcessEvent, ProcessPort } from '../../src/mcp/process.ts';
import type { NetPort } from '../../src/mcp/wire/link.ts';
import type { ServerSetup } from '../../src/mcp/setup.ts';
import { memorySettingsStore, type SettingsStore } from '../../src/settings/store.ts';
import { testPaths, REPO } from './fake.ts';
import { fakeProcess, initResult, listResult, realClock } from './wire-fakes.ts';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** A local setup the path rules take on any platform. */
const local = (id: string): ServerSetup => ({ kind: 'local', id, label: `Files ${id}`, program: process.execPath, args: ['x.js'], cwd: REPO, env: [], secrets: [] });

const ownerPorts = (store: SettingsStore): OwnerPorts => ({
  store,
  forget: async () => {},
  addresses: { add: async () => ({ id: 'addr-1' }), remove: async () => {}, list: async () => [] },
  secrets: { delete: async () => {} },
  now: () => 0
});

/** A process port where each server's runs answer the handshake and list `echo`. */
function speakingPort(hold?: (id: string, msg: any) => Promise<void> | undefined) {
  const starts: string[] = [];
  const procs = new Map<string, ReturnType<typeof fakeProcess>>();
  const runOf = new Map<string, string>();
  const port: ProcessPort = {
    async start(setup, onEvent) {
      starts.push(setup.id);
      const fp = fakeProcess((msg) => (msg.method === 'initialize' ? [JSON.stringify(initResult(msg.id))] : msg.method === 'tools/list' ? [JSON.stringify(listResult(msg.id, ['echo']))] : []));
      procs.set(setup.id, fp);
      const { run } = await fp.port.start(setup, onEvent);
      const id = `${setup.id}-${starts.length}`;
      runOf.set(id, setup.id);
      void run;
      return { run: id };
    },
    async write(run, bytes) {
      const id = runOf.get(run)!;
      const msg = JSON.parse(new TextDecoder().decode(bytes));
      await hold?.(id, msg);
      return procs.get(id)!.port.write('p1', bytes);
    },
    async stop(run) {
      return procs.get(runOf.get(run)!)!.port.stop('p1');
    },
    async forget() {}
  };
  return { port, starts };
}

async function clientOf(store: SettingsStore, processes: ProcessPort, extra: Partial<McpClientOptions> = {}) {
  return McpClient.open({ store, processes, net: {} as never, addresses: { add: async () => ({ id: 'addr-1' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: realClock, paths: testPaths, ...extra });
}

describe('5.1: a saved setup, as the owner keeps it', () => {
  it("a nested field of the wrong shape makes the record unreadable: it's never started, and the owner stays free", async () => {
    const store = memorySettingsStore();
    const one = await clientOf(store, speakingPort().port);
    await one.add({ setup: local('l1'), problems: [] });
    const doc: any = (await store.get(OWNER_KEY))!.value;
    doc.servers.l1.setup.env = [null];
    doc.servers.l1.enabled = true;
    await store.put(OWNER_KEY, { v: OWNER_VERSION, value: doc });
    const two = await clientOf(store, speakingPort().port);
    expect(two.owner.unreadableServers()).toEqual(['l1']);
    expect(await two.start('l1')).toMatchObject({ kind: 'refused' });
    expect(two.owner.busy).toBe(false);
  });

  it("a start whose target can't be built answers failed and releases the owner", async () => {
    const store = memorySettingsStore();
    const client = await clientOf(store, speakingPort().port);
    await client.add({ setup: local('l1'), problems: [] });
    // A record past the load check that still can't be launched (a test reaches in; nothing else can).
    const real = client.owner.server.bind(client.owner);
    client.owner.server = (id: string) => {
      const s = real(id);
      return s && ({ ...s, setup: { ...s.setup, env: [null] } } as never);
    };
    const r = await client.start('l1');
    expect(r).toMatchObject({ kind: 'failed' });
    expect(client.owner.busy).toBe(false);
    expect(client.get('l1')!.phase).toBe('failed');
  });

  it('each nested field is checked on load', async () => {
    const bad: [string, (s: any) => void][] = [
      ['an argument', (s) => (s.args = [1])],
      ['a setting pair', (s) => (s.env = [['A']])],
      ['a setting value', (s) => (s.env = [['A', 2]])],
      ['a secret name', (s) => (s.secrets = [null])]
    ];
    for (const [what, spoil] of bad) {
      const store = memorySettingsStore();
      const owner = await Owner.open(ownerPorts(store));
      await owner.add(local('l1'));
      const doc: any = (await store.get(OWNER_KEY))!.value;
      spoil(doc.servers.l1.setup);
      await store.put(OWNER_KEY, { v: OWNER_VERSION, value: doc });
      expect((await Owner.open(ownerPorts(store))).unreadableServers(), what).toEqual(['l1']);
    }
    const remoteBad: [string, (s: any) => void][] = [
      ['a header pair', (s) => (s.headers = [['X-A', 1]])],
      ['the key', (s) => (s.key = { header: 'authorization' })],
      ['the address', (s) => (s.address = 7)],
      ['the transport', (s) => (s.transport = 'carrier-pigeon')]
    ];
    for (const [what, spoil] of remoteBad) {
      const store = memorySettingsStore();
      const owner = await Owner.open(ownerPorts(store));
      await owner.add({ kind: 'remote', id: 'r1', label: 'R', url: 'https://h.example/mcp', transport: 'http', headers: [], key: { header: 'authorization', prefix: 'Bearer ' } });
      const doc: any = (await store.get(OWNER_KEY))!.value;
      spoil(doc.servers.r1.setup);
      await store.put(OWNER_KEY, { v: OWNER_VERSION, value: doc });
      expect((await Owner.open(ownerPorts(store))).unreadableServers(), what).toEqual(['r1']);
    }
  });

  it("the owner keeps its own copy: a draft changed after add, or a setup read and changed, changes nothing saved or launched", async () => {
    const store = memorySettingsStore();
    const owner = await Owner.open(ownerPorts(store));
    const setup = local('l1') as any;
    expect(await owner.add(setup)).toEqual({ ok: true });
    setup.args.push('--more');
    expect((owner.server('l1')!.setup as any).args).toEqual(['x.js']);
    (owner.server('l1')!.setup as any).args.push('--more');
    expect((owner.server('l1')!.setup as any).args).toEqual(['x.js']);
    const edited = { ...local('l1'), args: ['y.js'] } as any;
    expect(await owner.edit('l1', edited, true)).toEqual({ ok: true });
    edited.args.push('--more');
    expect((owner.server('l1')!.setup as any).args).toEqual(['y.js']);
    expect(((await store.get(OWNER_KEY))!.value as any).servers.l1.setup.args).toEqual(['y.js']);
  });
});

describe('5.4: one start at a time owns the phase', () => {
  for (const variant of ['net-held', 'net-cancel-late'] as const) {
    // net-cancel-late is a preserved-behaviour control: it held before the start tokens too, and stays.
    it(`a start stopped and started again before it settles: the earlier answers stopped and never sets the later start's phase (${variant === 'net-cancel-late' ? 'net-cancel-late, a preserved behaviour' : variant})`, async () => {
      const store = memorySettingsStore();
      let fetches = 0;
      let releaseA!: () => void;
      const aHeld = new Promise<void>((r) => (releaseA = r));
      const bodies = new Map<string, Uint8Array[]>();
      const net: NetPort = {
        async fetch(spec, body) {
          const n = ++fetches;
          const msg = JSON.parse(new TextDecoder().decode(body));
          // A's initialize hangs until released.
          if (n === 1) await aHeld;
          const reply = msg.method === 'initialize' ? initResult(msg.id) : msg.method === 'tools/list' ? listResult(msg.id, ['echo']) : undefined;
          bodies.set(spec.id, reply ? [new TextEncoder().encode(JSON.stringify(reply))] : []);
          return { status: reply ? 200 : 202, statusText: '', headers: [['content-type', 'application/json']], url: spec.url, redirected: false };
        },
        async read(id) {
          await Promise.resolve();
          return bodies.get(id)?.shift() ?? new Uint8Array(0);
        },
        async cancel() {
          if (variant === 'net-cancel-late') await tick(1);
        }
      };
      const client = await clientOf(store, {} as never, { net });
      await client.add({ setup: { kind: 'remote', id: 'r', label: 'R', url: 'https://h.example/mcp', transport: 'http', headers: [] }, problems: [] });
      const a = client.start('r');
      await tick();
      expect((await client.stop('r')).kind).toBe('stopped');
      const b = client.start('r');
      await tick(1);
      releaseA();
      expect((await a).kind).toBe('stopped');
      const bReply = await b;
      await tick(20);
      if (variant === 'net-held') {
        // A's cleanup was done before B: B runs.
        expect(bReply).toEqual({ kind: 'ready' });
        expect(client.get('r')!.phase).toBe('ready');
        expect(client.tools().map((t) => t.serverName)).toEqual(['echo']);
      } else {
        // A's cancel still draining: the link refuses B on its own (one exchange per server, cleanup
        // included), and the phase is B's outcome, not A's.
        expect(bReply).toMatchObject({ kind: 'failed', failure: { kind: 'busy' } });
        expect(client.get('r')).toMatchObject({ phase: 'failed', failure: (bReply as { failure: unknown }).failure });
      }
    });
  }
});

describe('5.3: starting with the app', () => {
  it('a server disabled while an earlier one starts is not started: each automatic start reads the committed flag', async () => {
    const store = memorySettingsStore();
    let releaseA!: () => void;
    const aHeld = new Promise<void>((r) => (releaseA = r));
    const { port, starts } = speakingPort((id, msg) => (id === 'A' && msg.method === 'initialize' ? aHeld : undefined));
    const client = await clientOf(store, port);
    await client.add({ setup: local('A'), problems: [] });
    await client.add({ setup: local('B'), problems: [] });
    await client.setEnabled('A', true);
    await client.setEnabled('B', true);
    const all = client.startEnabled();
    await tick(10);
    expect(starts).toEqual(['A']);
    await client.setEnabled('B', false);
    releaseA();
    await all;
    expect(starts).toEqual(['A']);
    expect(client.get('A')!.phase).toBe('ready');
    expect(client.get('B')!.phase).toBe('stopped');
  });

  it("an automatic start's modern relaunch reads the committed flag too: turned off during the first attempt, it isn't launched again", async () => {
    for (const disable of [true, false]) {
      const store = memorySettingsStore();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let starts = 0;
      let emit!: (e: ProcessEvent) => void;
      // A modern-only stdio server: it refuses the legacy opening and ends its process; a relaunch with the
      // era fixed lists its tools.
      const port: ProcessPort = {
        async start(_s, onEvent) {
          emit = onEvent;
          return { run: `p${++starts}` };
        },
        async write(_run, bytes) {
          const msg = JSON.parse(new TextDecoder().decode(bytes));
          if (msg.method === 'initialize') {
            await held;
            const refusal = { jsonrpc: '2.0', id: msg.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested: '2025-11-25' } } };
            queueMicrotask(() => (emit({ t: 'out', line: JSON.stringify(refusal) }), emit({ t: 'exit', code: 0 })));
          } else if (msg.method === 'tools/list') {
            const list = { jsonrpc: '2.0', id: msg.id, result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: [{ name: 'look', inputSchema: { type: 'object', properties: {} } }] } };
            queueMicrotask(() => emit({ t: 'out', line: JSON.stringify(list) }));
          }
        },
        async stop() {
          queueMicrotask(() => emit({ t: 'exit', code: 0 }));
        },
        async forget() {}
      };
      const client = await clientOf(store, port);
      await client.add({ setup: local('A'), problems: [] });
      await client.setEnabled('A', true);
      const all = client.startEnabled();
      await tick(10);
      expect(starts).toBe(1);
      if (disable) await client.setEnabled('A', false);
      release();
      await all;
      // The control, still enabled: the relaunch runs and the server is Ready.
      expect(starts, disable ? 'turned off' : 'still on').toBe(disable ? 1 : 2);
      expect(client.get('A')!.phase).toBe(disable ? 'stopped' : 'ready');
      expect(client.owner.busy).toBe(false);
    }
  });
});

describe('5.1 and 5.5: a lost or revoked choice never loosens to run-without-asking', () => {
  const noteAdd = { name: 'note_add', kind: 'effect' } as never;
  const look = { name: 'note_search', kind: 'read' } as never;

  it("an unreadable choice for a built-in that runs without asking loads as ask, not as the built-in's allow", async () => {
    const store = memorySettingsStore();
    await store.put(OWNER_KEY, { v: OWNER_VERSION, value: { rev: 1, servers: {}, keys: [], tombstones: {}, choices: { [choiceKey(BUILT_IN, 'note_add')]: { policy: 'deny', fingerprint: 3 }, [choiceKey(BUILT_IN, 'note_search')]: 'garbage' } } as never });
    const client = await clientOf(store, speakingPort().port);
    expect(gateFor('note_add', noteAdd, client.policy([]))).toBe('ask');
    expect(gateFor('note_search', look, client.policy([]))).toBe('ask');
    // A key that isn't a choice key at all names no tool, and breaks nothing.
    await store.put(OWNER_KEY, { v: OWNER_VERSION, value: { rev: 1, servers: {}, keys: [], tombstones: {}, choices: { 'not json': { policy: 'allow', fingerprint: '', setupFingerprint: '' } } } as never });
    expect((await clientOf(store, speakingPort().port)).policy([])).toEqual({ perTool: {} });
  });

  it("the whole record unreadable (choices null, or a record of the next version): every built-in asks, never its default allow, and a revoke to never still denies", async () => {
    const bad: [string, { v: number; value: unknown }][] = [
      ['choices null', { v: OWNER_VERSION, value: { rev: 3, servers: {}, keys: [], tombstones: {}, choices: null } }],
      ['the next version', { v: OWNER_VERSION + 1, value: { rev: 3, servers: {}, keys: [], tombstones: {}, choices: { [choiceKey(BUILT_IN, 'note_add')]: { policy: 'deny', fingerprint: '', setupFingerprint: '' } } } }]
    ];
    for (const [what, record] of bad) {
      const store = memorySettingsStore();
      await store.put(OWNER_KEY, record as never);
      const client = await clientOf(store, speakingPort().port);
      expect(client.owner.unreadable, what).toBe(true);
      expect(gateFor('note_add', noteAdd, client.policy([])), what).toBe('ask');
      expect(gateFor('note_search', look, client.policy([])), what).toBe('ask');
      // A stricter overlay is kept: a revoke to never denies, though it can't be saved.
      expect(await client.revoke(BUILT_IN, 'note_add', 'never'), what).toMatchObject({ ok: false, words: expect.stringMatching(/not saved/) });
      expect(gateFor('note_add', noteAdd, client.policy([])), what).toBe('deny');
      expect(gateFor('note_search', look, client.policy([])), what).toBe('ask');
    }
  });

  it('a revoke to Ask of a built-in holds as ask at once and is saved as ask, so a restart keeps it', async () => {
    const store = memorySettingsStore();
    const client = await clientOf(store, speakingPort().port);
    await client.choose(BUILT_IN, 'note_add', { policy: 'deny', fingerprint: '', setupFingerprint: '' });
    expect(gateFor('note_add', noteAdd, client.policy([]))).toBe('deny');
    // Ask after never isn't a tightening: never stays.
    expect(await client.revoke(BUILT_IN, 'note_add', 'ask')).toEqual({ ok: true });
    expect(gateFor('note_add', noteAdd, client.policy([]))).toBe('deny');
    // A built-in reads its default allow when nothing is saved; a revoke to Ask makes it ask, at once and after.
    const revoking = client.revoke(BUILT_IN, 'note_search', 'ask');
    expect(gateFor('note_search', look, client.policy([]))).toBe('ask');
    expect(await revoking).toEqual({ ok: true });
    expect(client.choices()[choiceKey(BUILT_IN, 'note_search')]).toMatchObject({ policy: 'ask' });
    const again = await clientOf(store, speakingPort().port);
    expect(gateFor('note_search', look, again.policy([]))).toBe('ask');
  });

  it('a revoke the owner refuses holds for now and says it was not saved; a restart brings the saved choice back', async () => {
    const store = memorySettingsStore();
    const client = await clientOf(store, speakingPort().port);
    await client.choose('s1', 'echo', { policy: 'allow', fingerprint: 'f', setupFingerprint: 'l' });
    const busy = client.owner.admit('other');
    if (!('release' in busy)) throw new Error('not admitted');
    const r = await client.revoke('s1', 'echo', 'ask');
    busy.release();
    expect(r).toMatchObject({ ok: false, words: expect.stringMatching(/not saved/) });
    expect((client as any).overlay.get(choiceKey('s1', 'echo'))).toBe('ask');
    expect((await clientOf(store, speakingPort().port)).choices()[choiceKey('s1', 'echo')]?.policy).toBe('allow');
    // A failing store says the same.
    const failing: SettingsStore = { ...store, putIf: async () => false };
    const other = await clientOf(failing, speakingPort().port);
    expect(await other.revoke('s1', 'echo', 'never')).toMatchObject({ ok: false, words: expect.stringMatching(/not saved/) });
  });
});

describe('5.4: Mark reviewed marks what Test showed', () => {
  for (const how of ['the report', 'names'] as const) {
    it(`Test shows F1, the catalog moves to F2, then Mark reviewed (${how}): F2 is still unreviewed`, async () => {
      const store = memorySettingsStore();
      const client = await clientOf(store, speakingPort().port);
      await client.add({ setup: local('l1'), problems: [] });
      const report = await client.test('l1');
      if (!report.ok) throw new Error('test failed');
      const f1 = report.tools.find((t) => t.name === 'echo')!.fingerprint;
      // A run lists echo changed before the person presses Mark reviewed.
      await client.owner.seen('l1', [{ name: 'echo', fingerprint: 'F2' }]);
      await client.markReviewed('l1', how === 'names' ? ['echo'] : report.tools);
      expect(client.owner.server('l1')!.tools).toEqual([{ name: 'echo', fingerprint: 'F2', reviewed: f1 }]);
      // Back at F1, what the person saw: reviewed.
      await client.owner.seen('l1', [{ name: 'echo', fingerprint: f1, reviewed: f1 }]);
      expect(client.get('l1')!.tools).toEqual([{ name: 'echo', fingerprint: f1, reviewed: f1 }]);
    });
  }

  it('a name Test never showed is marked nothing', async () => {
    const store = memorySettingsStore();
    const client = await clientOf(store, speakingPort().port);
    await client.add({ setup: local('l1'), problems: [] });
    await client.owner.seen('l1', [{ name: 'echo', fingerprint: 'F1' }]);
    await client.markReviewed('l1', ['echo']);
    expect(client.owner.server('l1')!.tools).toEqual([{ name: 'echo', fingerprint: 'F1' }]);
  });
});

describe('5.5: a revoke holds until the person chooses again', () => {
  it('a revoke to never, then a choice of allow that saves: the overlay goes and allow stands', async () => {
    const store = memorySettingsStore();
    const client = await clientOf(store, speakingPort().port);
    const noteAdd = { name: 'note_add', kind: 'effect' } as never;
    expect(await client.revoke(BUILT_IN, 'note_add', 'never')).toEqual({ ok: true });
    expect(gateFor('note_add', noteAdd, client.policy([]))).toBe('deny');
    await client.choose(BUILT_IN, 'note_add', { policy: 'allow', fingerprint: '', setupFingerprint: '' });
    expect(gateFor('note_add', noteAdd, client.policy([]))).toBe('allow');
    // A server tool's: the overlay no longer refuses at the send either.
    await client.revoke('s1', 'echo', 'never');
    await client.choose('s1', 'echo', { policy: 'allow', fingerprint: 'f', setupFingerprint: 'l' });
    expect((client as any).overlay.has(choiceKey('s1', 'echo'))).toBe(false);
  });

  it('a choice that is not saved leaves the revoke, and a revoke made while a choice is saving outlives it', async () => {
    const store = memorySettingsStore();
    const client = await clientOf(store, speakingPort().port);
    const noteAdd = { name: 'note_add', kind: 'effect' } as never;
    await client.revoke(BUILT_IN, 'note_add', 'never');
    const busy = client.owner.admit('other');
    if (!('release' in busy)) throw new Error('not admitted');
    await expect(client.choose(BUILT_IN, 'note_add', { policy: 'allow', fingerprint: '', setupFingerprint: '' })).rejects.toThrow();
    busy.release();
    expect(gateFor('note_add', noteAdd, client.policy([]))).toBe('deny');
    // The choice's write held; a revoke lands meanwhile; the choice then saves: the later revoke stands.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow: SettingsStore = { ...store, putIf: async (k, r, g) => (await held, store.putIf(k, r, g)) };
    const other = await clientOf(slow, speakingPort().port);
    const choosing = other.choose(BUILT_IN, 'note_search', { policy: 'allow', fingerprint: '', setupFingerprint: '' });
    await tick(1);
    void other.revoke(BUILT_IN, 'note_search', 'never');
    release();
    await choosing;
    expect(gateFor('note_search', { name: 'note_search', kind: 'read' } as never, other.policy([]))).toBe('deny');
  });
});

describe("5.4: a server's limits apply from the next start", () => {
  it('a changed handshake limit is the next Start\'s deadline', async () => {
    const store = memorySettingsStore();
    const delays: number[] = [];
    const clock = { now: () => Date.now(), setTimer: (cb: () => void, ms: number) => (delays.push(ms), realClock.setTimer(cb, ms)) };
    const client = await clientOf(store, speakingPort().port, { clock });
    await client.add({ setup: local('l1'), problems: [] });
    expect((await client.start('l1')).kind).toBe('ready');
    expect(delays).toContain(60_000);
    expect(delays).not.toContain(7_000);
    await client.stop('l1');
    await client.setLimits('l1', { initMs: 7_000 });
    delays.length = 0;
    expect((await client.start('l1')).kind).toBe('ready');
    expect(delays).toContain(7_000);
    expect(delays).not.toContain(60_000);
  });
});
