// Review r20's exact cases, with ports a test holds and lets go of by hand, and a clock it moves itself.
// An effect past its deadline stays owned until it lands: its caller hears it timed out, the server is
// busy for anything that conflicts, and what lands late is what's kept.
import { describe, expect, it } from 'vitest';
import { McpClient, localDraft, posixPaths, remoteDraft, type ListedTool, type Session, type SettingsStore } from '../../src/index.ts';
import { memorySettingsStore } from '../../src/settings/store.ts';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

/** Calls that wait until the test lets them go, in order or by name. */
class Held {
  private q: { name: string; go: () => void }[] = [];
  hold<T>(name: string, f: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => this.q.push({ name, go: () => { Promise.resolve().then(f).then(resolve, reject); } }));
  }
  names(): string[] { return this.q.map(x => x.name); }
  async release(name: string): Promise<void> {
    const i = this.q.findIndex(x => x.name.startsWith(name));
    if (i < 0) throw new Error(`nothing held named ${name}: ${this.names().join(', ')}`);
    this.q.splice(i, 1)[0]!.go();
    await flush();
  }
  async releaseAll(): Promise<void> { while (this.q.length) await this.release(this.q[0]!.name); }
}

function world(holdStore: (op: string) => boolean = () => false) {
  const held = new Held();
  let now = 0;
  let timers: { at: number; f: () => void; live: boolean }[] = [];
  const raw = memorySettingsStore();
  const wrap = <T>(op: string, f: () => Promise<T>) => (holdStore(op) ? held.hold(`store.${op}`, f) : f());
  const store: SettingsStore = {
    get: k => raw.get(k), put: (k, r) => raw.put(k, r), delete: k => raw.delete(k), keys: p => raw.keys(p),
    putIf: (k, r, g) => wrap('putIf', () => raw.putIf(k, r, g)),
    deleteIf: (k, g) => wrap('deleteIf', () => raw.deleteIf(k, g))
  };
  const secrets = new Map<string, string>();
  const addresses = new Map<string, string>();
  const tools: ListedTool[] = [{ name: 'echo', inputSchema: { type: 'object' }, fingerprint: 'f1' }];
  let inc = 0;
  const open = McpClient.open({
    store, paths: posixPaths,
    processes: { start: async () => ({ run: 'x' }), write: async () => {}, stop: async () => {}, forget: async () => {} },
    fetchFor: () => fetch,
    addresses: {
      add: ({ url }) => held.hold(`address.add ${url}`, () => {
        const id = url.includes('/two') || url.includes('/one') ? 'addr-shared' : `addr-${url}`;
        addresses.set(id, url);
        return { id };
      }),
      remove: async id => { addresses.delete(id); }
    },
    secrets: { delete: ref => held.hold(`secret.delete ${ref}`, () => { secrets.delete(ref); }) },
    clock: { now: () => now, setTimer: (f, ms) => { const t = { at: now + ms, f, live: true }; timers.push(t); return () => { t.live = false; }; } },
    limits: { saveMs: 100, startMs: 100 },
    newIncarnation: () => `inc-${++inc}`,
    connect: (_s, events): Session => {
      queueMicrotask(() => { events.launched(); events.ready(tools); });
      return { call: async () => ({ kind: 'result', text: 'ok', isError: false }), list: async () => tools, close: () => queueMicrotask(() => events.closed()) };
    }
  });
  const advance = async (ms: number) => {
    now += ms;
    const due = timers.filter(t => t.live && t.at <= now);
    timers = timers.filter(t => !due.includes(t));
    for (const t of due) { t.live = false; t.f(); }
    await flush();
  };
  return { open, held, raw, secrets, addresses, advance };
}

const local = (id: string, secret: boolean) =>
  localDraft({ label: id, command: '/bin/server', args: ['x@1.0.0'], cwd: '/srv', settings: secret ? [{ name: 'API_KEY', value: 'value-one', secret: true }] : [] }, { newId: () => id, paths: posixPaths });
const settle = <T>(p: Promise<T>) => p.then(v => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e: e.message }));

describe("review r20's cases: an effect stays owned until it lands", () => {
  it('#6: two adds of one address at once: one is refused, before the dialog or by the id the exe gives', async () => {
    const w = world();
    const c = await w.open;
    const one = settle(c.add(remoteDraft({ label: 'One', url: 'https://mcp.example.test/one', headers: [] }, { newId: () => 'a' })));
    // The same address, written differently: refused at once, while the first add's dialog is up.
    const same = await settle(c.add(remoteDraft({ label: 'Same', url: 'https://mcp.example.test/one/', headers: [] }, { newId: () => 'b' })));
    expect(same).toMatchObject({ ok: false, e: expect.stringMatching(/Another server, One, already uses this address/) });
    // Another URL the exe gives the same address id: refused by that id, and the address isn't removed.
    const two = settle(c.add(remoteDraft({ label: 'Two', url: 'https://mcp.example.test/two', headers: [] }, { newId: () => 'c' })));
    await w.held.release('address.add https://mcp.example.test/one');
    await w.held.release('address.add https://mcp.example.test/two');
    expect(await one).toMatchObject({ ok: true });
    expect(await two).toMatchObject({ ok: false, e: expect.stringMatching(/Another server, One, already uses this address/) });
    expect(c.list().map(s => s.id)).toEqual(['a']);
    expect(w.addresses.has('addr-shared')).toBe(true);
  });

  it("#3: an edit that drops a secret owns its delete; a second edit bringing it back waits, so the new value isn't deleted", async () => {
    const w = world();
    const c = await w.open;
    await c.add(local('a', true));
    w.secrets.set('server:a:API_KEY', 'first');
    const drop = settle(c.edit('a', local('a', false)));
    await flush();
    expect(w.held.names()).toEqual(['secret.delete server:a:API_KEY']);
    // The second edit, bringing the secret back, is refused while the first's delete is owned.
    expect(await settle(c.edit('a', local('a', true)))).toMatchObject({ ok: false, e: expect.stringMatching(/still finishing an earlier change|being saved/) });
    // Past the deadline, the first edit's caller hears it timed out; the delete is still owned.
    await w.advance(200);
    expect(await drop).toMatchObject({ ok: false, e: expect.stringMatching(/didn't finish in time/) });
    expect(await settle(c.edit('a', local('a', true)))).toMatchObject({ ok: false, e: expect.stringMatching(/still finishing an earlier change/) });
    await w.held.release('secret.delete');
    // Now the second edit goes, and Settings stores its new value, which nothing deletes.
    expect(await settle(c.edit('a', local('a', true)))).toMatchObject({ ok: true });
    w.secrets.set('server:a:API_KEY', 'second');
    await flush();
    expect(w.secrets.get('server:a:API_KEY')).toBe('second');
    expect(c.record('a')!.setup).toMatchObject({ secrets: ['API_KEY'] });
  });

  it('#4: a write past its deadline answers timed out, stays owned, and what it lands is what the server keeps', async () => {
    const w = world(op => op === 'putIf');
    const c = await w.open;
    const adding = settle(c.add(local('a', false)));
    await w.held.release('store.putIf');
    expect(await adding).toMatchObject({ ok: true });
    const editing = settle(c.edit('a', { ...local('a', false), setup: { ...local('a', false).setup, args: ['x@2.0.0'] } as never }));
    await flush();
    await w.advance(200);
    expect(await editing).toMatchObject({ ok: false, e: expect.stringMatching(/didn't finish in time/) });
    expect(await settle(c.start('a'))).toMatchObject({ ok: true, v: expect.objectContaining({ kind: 'refused' }) });
    await w.held.release('store.putIf');
    // The late write landed: the server holds it too, so the store and the server agree.
    const stored = (await w.raw.get('mcp.server.a'))!.value as { setup: { args: string[] } };
    expect(stored.setup.args).toEqual(['x@2.0.0']);
    expect(c.record('a')!.setup).toMatchObject({ args: ['x@2.0.0'] });
  });

  it('#2: a removal past its deadline stays owned; the id stays taken until it lands, and a re-add after is untouched', async () => {
    const w = world(op => op === 'deleteIf');
    const c = await w.open;
    await c.add(local('a', false));
    const removing = settle(c.remove('a'));
    await flush();
    await w.advance(200);
    expect(await removing).toMatchObject({ ok: true, v: { kind: 'failed', failure: expect.objectContaining({ kind: 'timed-out' }) } });
    expect(await settle(c.remove('a'))).toMatchObject({ ok: true, v: expect.objectContaining({ kind: 'refused' }) });
    expect(await settle(c.add(local('a', false)))).toMatchObject({ ok: false, e: 'A server with this id is already saved.' });
    await w.held.release('store.deleteIf');
    expect(c.list()).toEqual([]);
    // Re-added now, it's a new incarnation, and the old removal can't touch it.
    expect(await settle(c.add(local('a', false)))).toMatchObject({ ok: true });
    expect(((await w.raw.get('mcp.server.a'))!.value as { incarnation: string }).incarnation).toBe('inc-2');
  });

  it('#5: a stalled write keeps its waiters within the cap, past which a change is refused at once', async () => {
    const w = world(op => op === 'putIf');
    const c = await w.open;
    const adding = settle(c.add(local('a', false)));
    await w.held.release('store.putIf');
    await adding;
    const changes = Array.from({ length: 10_000 }, (_, i) => settle(c.setEnabled('a', i % 2 === 0)));
    await flush();
    expect(c.waiting('a')).toBeLessThanOrEqual(8 + 1);
    const refused = (await Promise.race([Promise.all(changes.slice(9)), new Promise(r => setTimeout(r, 50, 'pending'))]));
    expect(refused).not.toBe('pending');
    await w.held.releaseAll();
    await w.held.releaseAll();
  });
});
