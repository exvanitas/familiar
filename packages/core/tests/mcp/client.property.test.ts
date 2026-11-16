// The whole client under a seeded scheduler, with fake ports whose every effect can stall, land in any
// order, or land after its deadline: the store's guarded writes and deletes, Credential Manager's deletes,
// the exe's address add and remove and server_forget, and sessions that storm "tools changed". Random
// adds (with clashing ids and addresses), edits, removes, starts, stops and metadata changes, with
// deadlines firing. Settings stores a secret's value whenever an add or edit says it needs one. After
// each sequence everything pending lands and every timer fires, and then:
//   - every public promise settled
//   - the store holds, for each server, exactly the record its actor committed, and nothing for a server
//     that's gone; no late write or delete touched a newer revision or a re-added server
//   - every secret a server needs is still in Credential Manager, and no address serves two servers
//   - pending waits per server stayed under the cap all along
// A control plants one late write past the fence, and the checks must catch it.
import { describe, expect, it } from 'vitest';
import { McpClient, keyOf, localDraft, remoteDraft, posixPaths, type Draft, type ListedTool, type Session, type SessionEvents, type SettingsStore, type Stored } from '../../src/index.ts';
import { memorySettingsStore } from '../../src/settings/store.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Effects waiting to land, and timers waiting to fire, run in an order the seed picks. */
class Scheduler {
  now = 0;
  private jobs: (() => void)[] = [];
  private timers: { at: number; f: () => void; live: boolean }[] = [];
  private readonly r: () => number;
  constructor(r: () => number) {
    this.r = r;
  }
  /** An effect: it lands when the scheduler runs it. */
  later<T>(f: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => this.jobs.push(() => { Promise.resolve().then(f).then(resolve, reject); }));
  }
  setTimer = (f: () => void, ms: number) => {
    const t = { at: this.now + ms, f, live: true };
    this.timers.push(t);
    return () => { t.live = false; };
  };
  /** One random job, or the earliest timer. False when nothing is left. */
  async tick(preferJobs: number): Promise<boolean> {
    await flush();
    this.timers = this.timers.filter(t => t.live);
    if (this.jobs.length && (this.r() < preferJobs || !this.timers.length)) {
      // Half the time the newest job, so older ones stall, often past their deadlines.
      const i = this.r() < 0.5 ? this.jobs.length - 1 : Math.floor(this.r() * this.jobs.length);
      const [job] = this.jobs.splice(i, 1);
      job!();
      await flush();
      return true;
    }
    if (!this.timers.length) return false;
    const t = this.timers.reduce((a, b) => (b.at < a.at ? b : a));
    t.live = false;
    this.now = Math.max(this.now, t.at);
    t.f();
    await flush();
    return true;
  }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** The settings store, each operation landing when the scheduler says. */
function stallingStore(inner: SettingsStore, s: Scheduler): SettingsStore {
  return {
    get: k => s.later(() => inner.get(k)),
    put: (k, r) => s.later(() => inner.put(k, r)),
    delete: k => s.later(() => inner.delete(k)),
    keys: p => s.later(() => inner.keys(p)),
    putIf: (k, r, g) => s.later(() => inner.putIf(k, r, g)),
    deleteIf: (k, g) => s.later(() => inner.deleteIf(k, g))
  };
}

const TOOLS: ListedTool[] = [{ name: 'echo', inputSchema: { type: 'object' }, fingerprint: 'f1' }];

interface World {
  s: Scheduler;
  store: SettingsStore;
  raw: SettingsStore;
  client: McpClient;
  secrets: Map<string, string>;
  /** Refs Settings stored a value for, with the committed setup it was stored for. A setup committed
      later (an add or edit that landed after its deadline, whose caller heard it failed) never had its
      value stored, so Settings would ask for it: that's not a lost secret. */
  everSet: Map<string, object>;
  addresses: Map<string, string>;
  settled: { done: boolean; what: string }[];
  maxWaiting: number;
  problems: string[];
}

async function makeWorld(seed: number): Promise<World> {
  const r = rng(seed);
  const s = new Scheduler(r);
  const raw = memorySettingsStore();
  const store = stallingStore(raw, s);
  const secrets = new Map<string, string>();
  const addresses = new Map<string, string>();
  let inc = 0;
  const client = await (async () => {
    const opening = McpClient.open({
      store,
      paths: posixPaths,
      processes: { start: async () => ({ run: 'x' }), write: async () => {}, stop: async () => {}, forget: () => s.later(() => {}) },
      fetchFor: () => fetch,
      // The exe gives an identical address the same id.
      addresses: {
        add: ({ url }) => s.later(() => {
          const id = `addr-${url.replace(/\/+$/, '').toLowerCase()}`;
          addresses.set(id, url);
          return { id };
        }),
        remove: id => s.later(() => { addresses.delete(id); })
      },
      secrets: { delete: ref => s.later(() => { secrets.delete(ref); }) },
      clock: { now: () => s.now, setTimer: s.setTimer },
      limits: { saveMs: 50, startMs: 80, initMs: 80, listMs: 60, stopMs: 40, backoffMs: 10, maxWaiters: 4, maxCalls: 4 },
      newIncarnation: () => `inc-${++inc}`,
      connect: (_setup, events) => fakeSession(s, r, events)
    });
    let open = false;
    void opening.then(() => { open = true; });
    for (let guard = 0; !open && guard < 1000; guard++) await s.tick(1);
    return opening;
  })();
  return { s, store, raw, client, secrets, everSet: new Map(), addresses, settled: [], maxWaiting: 0, problems: [] };
}

function fakeSession(s: Scheduler, r: () => number, events: SessionEvents): Session {
  let closed = false;
  void s.later(() => {
    if (closed) return;
    events.launched();
    void s.later(() => { if (!closed) events.ready(TOOLS); });
  });
  return {
    call: () => s.later(() => (closed ? undefined : { kind: 'result' as const, text: 'ok', isError: false })),
    list: () => s.later(() => TOOLS),
    close() {
      if (closed) return;
      closed = true;
      void s.later(() => events.closed());
    }
  };
}

/** A public promise, watched so the test can tell it settled. */
function watch(w: World, what: string, p: Promise<unknown>, then?: (v: unknown) => void) {
  const rec = { done: false, what };
  w.settled.push(rec);
  p.then(v => { rec.done = true; then?.(v); }, () => { rec.done = true; });
}

const IDS = ['a', 'b'];
const URLS = ['https://mcp.example.test/one', 'https://mcp.example.test/one/', 'https://mcp.example.test/two'];

function draftFor(r: () => number, id: string): Draft {
  if (r() < 0.4) return remoteDraft({ label: `R ${id}`, url: URLS[Math.floor(r() * URLS.length)]!, headers: [] }, { newId: () => id });
  const secret = r() < 0.6;
  return localDraft({ label: `L ${id}`, command: '/bin/server', args: [r() < 0.5 ? 'x@1.0.0' : 'x@2.0.0'], cwd: '/srv', settings: secret ? [{ name: 'API_KEY', value: 'value-one', secret: true }] : [] }, { newId: () => id, paths: posixPaths });
}

/** Edits that drop the secret and bring it back, which is where a late cleanup would bite. */
function toggled(r: () => number, id: string, had: boolean): Draft {
  return localDraft({ label: `L ${id}`, command: '/bin/server', args: [r() < 0.5 ? 'x@1.0.0' : 'x@2.0.0'], cwd: '/srv', settings: had ? [] : [{ name: 'API_KEY', value: 'value-one', secret: true }] }, { newId: () => id, paths: posixPaths });
}

/** Settings stores a value for each secret the server now needs. */
function storeSecrets(w: World, id: string, refs: unknown) {
  const list = (refs as { secretRefs?: string[] } | undefined)?.secretRefs ?? [];
  const record = w.client.record(id);
  for (const ref of list) if (ref.startsWith('server:')) { w.secrets.set(ref, 'value'); if (record) w.everSet.set(ref, record.setup); }
}

async function check(w: World): Promise<string[]> {
  const problems: string[] = [];
  for (const rec of w.settled) if (!rec.done) problems.push(`${rec.what} never settled`);
  const live = new Map(w.client.list().map(s => [s.id, w.client.record(s.id)!]));
  for (const key of await w.raw.keys('mcp.server.')) {
    const id = key.slice('mcp.server.'.length);
    const stored = (await w.raw.get(key))!.value as { setup: unknown; enabled: boolean; limits: unknown; incarnation: string };
    const rec = live.get(id);
    if (!rec) { problems.push(`${id}: a record is saved for a server that's gone`); continue; }
    if (stored.incarnation !== rec.incarnation) problems.push(`${id}: the saved record is incarnation ${stored.incarnation}, the server is ${rec.incarnation}`);
    if (JSON.stringify([stored.setup, stored.enabled, stored.limits]) !== JSON.stringify([rec.setup, rec.enabled, rec.limits])) problems.push(`${id}: the saved record isn't the committed one`);
  }
  for (const [id, rec] of live) {
    if (!(await w.raw.get(keyOf(id)))) problems.push(`${id}: no record is saved for a live server`);
    if (rec.setup.kind === 'local') for (const name of rec.setup.secrets) if (w.everSet.get(`server:${id}:${name}`) === rec.setup && !w.secrets.has(`server:${id}:${name}`)) problems.push(`${id}: its secret ${name} was deleted while it needs it`);
    if (rec.setup.kind === 'remote' && rec.setup.address) {
      if (!w.addresses.has(rec.setup.address)) problems.push(`${id}: its address was removed while it uses it`);
      for (const [other, o] of live) if (other !== id && o.setup.kind === 'remote' && o.setup.address === rec.setup.address) problems.push(`${id} and ${other} share an address`);
    }
  }
  return problems;
}

async function run(seed: number, steps: number, plant = false): Promise<string[]> {
  const w = await makeWorld(seed);
  const r = rng(seed * 7919);
  let firstRecord: Stored | undefined;
  for (let i = 0; i < steps; i++) {
    const x = r();
    const id = IDS[Math.floor(r() * IDS.length)]!;
    const known = w.client.get(id) !== undefined;
    try {
      if (x < 0.15) watch(w, `add ${id}`, w.client.add(draftFor(r, id)), v => storeSecrets(w, id, v));
      else if (x < 0.27 && known) {
        const rec = w.client.record(id);
        const d = rec?.setup.kind === 'local' && r() < 0.7 ? toggled(r, id, rec.setup.secrets.length > 0) : draftFor(r, id);
        if (d.setup.kind === (w.client.record(id)?.setup.kind ?? '')) watch(w, `edit ${id}`, w.client.edit(id, d), v => storeSecrets(w, id, v));
      } else if (x < 0.35 && known) watch(w, `remove ${id}`, w.client.remove(id));
      else if (x < 0.43 && known) watch(w, `start ${id}`, w.client.start(id));
      else if (x < 0.48 && known) watch(w, `stop ${id}`, w.client.stop(id));
      else if (x < 0.53 && known) watch(w, `enable ${id}`, w.client.setEnabled(id, r() < 0.5));
      else if (x < 0.56 && known) watch(w, `limits ${id}`, w.client.setLimits(id, { callMs: 1000 + Math.floor(r() * 5) }));
      else if (x < 0.59 && known) watch(w, `review ${id}`, w.client.markReviewed(id, ['echo']));
      else await w.s.tick(0.6);
    } catch {
      // A refusal thrown at once (an id already saved, a bad draft) is an answer too.
    }
    for (const sid of IDS) w.maxWaiting = Math.max(w.maxWaiting, w.client.waiting(sid));
    if (!firstRecord) firstRecord = (await w.raw.get(keyOf('a'))) ?? undefined;
  }
  for (let guard = 0; guard < 5000 && (await w.s.tick(1)); guard++);
  // The control: a late write that skips the fence, carrying an old record.
  if (plant && firstRecord) await w.raw.put(keyOf('a'), firstRecord);
  const problems = await check(w);
  // 4 waiters each for starts, stops, removes and changes, 4 calls, an edit and an add.
  if (w.maxWaiting > 4 * 4 + 4 + 2) problems.push(`${w.maxWaiting} callers waited on one server`);
  return problems.map(p => `seed ${seed}: ${p}`);
}

describe('the whole client, with effects that stall and land late', () => {
  it('settles everything, and leaves the store, the secrets and the addresses as the actors committed them', async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= Number(process.env.SEEDS ?? 400); seed++) problems.push(...(await run(seed, 100)));
    expect(problems.slice(0, 8)).toEqual([]);
  });

  it('the control: a planted late write past the fence is caught', async () => {
    let planted = 0, caught = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const found = await run(seed, 60, true);
      planted++;
      if (found.some(p => /isn't the committed one|incarnation|gone/.test(p))) caught++;
    }
    expect(planted).toBe(60);
    expect(caught).toBeGreaterThan(10);
  });
});
