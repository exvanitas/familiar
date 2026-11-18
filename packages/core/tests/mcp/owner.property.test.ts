// T3, the owner property (docs/mcp-design.md 5.1 to 5.3): seeded histories of adds, edits, removes and
// choices, each life cut off at a seeded point where every port and store call after it hangs, as a killed
// app's would. Store and native steps are held a turn now and then, and a run's catalog write (`seen`)
// lands at seeded moments between and inside the changes, as runs listing their tools would. Each next
// life repairs, then the invariants hold:
//   - no mark is left, and no tombstone is unfinished;
//   - the exe's server addresses are exactly the ones remote records hold (no orphan, none missing);
//   - an id or key, once removed, never comes back for another server;
//   - a removed server's secrets were each deleted;
//   - never two store writes in flight, and no change answered "not saved" (nothing else writes).
import { describe, expect, it } from 'vitest';
import { Owner, OWNER_KEY, type OwnerPorts } from '../../src/mcp/owner.ts';
import type { ServerSetup } from '../../src/mcp/setup.ts';
import { memorySettingsStore, type SettingsStore } from '../../src/settings/store.ts';
import { rng } from '../harness/sched.ts';

const never = new Promise<never>(() => {});

interface Budget {
  left: number;
  /** The life was cut off: every call from now on hangs, a held one too. */
  killed?: true;
  /** Whether this call is held a turn first (seeded). */
  readonly hold: () => boolean;
  /** Store writes in flight now, and the most at once. */
  readonly writes: { now: number; most: number };
}

/** Each call spends the budget; once it's spent, every call hangs. A held call waits a macrotask first. */
const gateOf = (budget: Budget) => <T>(f: () => Promise<T>): Promise<T> =>
  budget.killed || budget.left-- <= 0 ? never : budget.hold() ? new Promise<void>((r) => setTimeout(r, 0)).then(() => (budget.killed ? never : f())) : f();

function killable(store: SettingsStore, budget: Budget): SettingsStore {
  const gate = gateOf(budget);
  return {
    get: (k) => gate(() => store.get(k)),
    put: (k, r) => gate(() => store.put(k, r)),
    delete: (k) => gate(() => store.delete(k)),
    keys: (p) => gate(() => store.keys(p)),
    putIf: (k, r, g) => {
      budget.writes.now++;
      budget.writes.most = Math.max(budget.writes.most, budget.writes.now);
      return gate(() => store.putIf(k, r, g)).finally(() => void budget.writes.now--);
    },
    deleteIf: (k, g) => gate(() => store.deleteIf(k, g))
  };
}

interface Exe {
  readonly addresses: Map<string, string>;
  readonly adds: string[];
  readonly deletedSecrets: Set<string>;
  n: number;
}

function ports(store: SettingsStore, exe: Exe, budget: Budget): OwnerPorts {
  const gate = gateOf(budget);
  return {
    store: killable(store, budget),
    forget: (_id) => gate(async () => {}),
    addresses: {
      add: ({ url }) =>
        gate(async () => {
          const id = `addr-${++exe.n}`;
          exe.addresses.set(id, url);
          exe.adds.push(url);
          return { id };
        }),
      // As the exe answers (address_remove): an address it doesn't hold, removed before a kill cut off
      // the done commit, is refused `not-saved`, never quietly deleted again.
      remove: (id) =>
        gate(async () => {
          if (!exe.addresses.delete(id)) throw { kind: 'not-saved', message: 'no such address' };
        }),
      list: () => gate(async () => [...exe.addresses].map(([id, url]) => ({ id, kind: 'server', url })))
    },
    secrets: { delete: (ref) => gate(async () => void exe.deletedSecrets.add(ref)) },
    now: () => 0
  };
}

const local = (id: string, secrets: string[]): ServerSetup => ({ kind: 'local', id, label: `Files ${id}`, program: 'npx', args: ['-y', 'files@1.0.0'], cwd: 'C:\\work', env: [], secrets });
const remote = (id: string, host: string): ServerSetup => ({ kind: 'remote', id, label: `Remote ${id}`, url: `https://${host}.example/mcp`, transport: 'http', headers: [] });

const witness = { marks: 0, tombstones: 0, catalogWrites: 0, catalogWhileBusy: 0 };

async function history(seed: number, repairs = true): Promise<string[]> {
  const r = rng(seed);
  // The held steps and the catalog writes have their own stream, so the changes are the seed's alone.
  const r2 = rng(seed * 31 + 7);
  const store = memorySettingsStore();
  const exe: Exe = { addresses: new Map(), adds: [], deletedSecrets: new Set(), n: 0 };
  const problems: string[] = [];
  const everKeys = new Map<string, string>(); // key -> id
  const removed = new Set<string>();
  const secretsOf = new Map<string, string[]>();
  let ids = 0;
  let listed = 0;
  for (let life = 1; life <= 4; life++) {
    // Each life runs until its budget of port and store calls is spent, then hangs.
    const budget: Budget = { left: life === 4 ? Infinity : 5 + Math.floor(r() * 60), hold: () => r2() < 0.3, writes: { now: 0, most: 0 } };
    const owner = await Promise.race([Owner.open(ports(store, exe, budget)).catch(() => undefined), new Promise<undefined>((res) => setTimeout(() => res(undefined), 20))]);
    if (!owner) {
      budget.killed = true;
      continue; // the life died while opening
    }
    const before = (await store.get(OWNER_KEY))?.value as any;
    if (before?.mark) witness.marks++;
    if (Object.values(before?.tombstones ?? {}).some((t: any) => Object.keys(t).length > 1)) witness.tombstones++;
    const opened = await Promise.race([(repairs ? owner.repair() : Promise.resolve()).then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 20))]);
    if (life === 4 || opened) {
      // Invariants after a repair that finished.
      const doc = (await store.get(OWNER_KEY))?.value as any;
      if (opened && doc?.mark) problems.push(`life ${life}: a mark left after repair: ${JSON.stringify(doc.mark)}`);
      const owned = new Set(owner.servers().flatMap((s) => (s.setup.kind === 'remote' && s.setup.address ? [s.setup.address] : [])));
      if (opened) for (const a of exe.addresses.keys()) if (!owned.has(a)) problems.push(`life ${life}: orphan address ${a}`);
      for (const a of owned) if (!exe.addresses.has(a)) problems.push(`life ${life}: a record holds missing address ${a}`);
      for (const [id, t] of Object.entries(owner.tombstones())) if (opened && Object.keys(t).length > 1) problems.push(`life ${life}: tombstone ${id} unfinished: ${JSON.stringify(t)}`);
      for (const s of owner.servers()) {
        const prev = everKeys.get(s.key);
        if (prev && prev !== s.setup.id) problems.push(`life ${life}: key ${s.key} reused for ${s.setup.id}, was ${prev}`);
        everKeys.set(s.key, s.setup.id);
        if (removed.has(s.setup.id)) problems.push(`life ${life}: removed id ${s.setup.id} came back`);
      }
      for (const id of Object.keys(owner.tombstones())) {
        removed.add(id);
        if (opened) for (const ref of secretsOf.get(id) ?? []) if (!exe.deletedSecrets.has(ref)) problems.push(`life ${life}: ${ref} of removed ${id} never deleted`);
      }
    }
    if (life === 4) break;
    // A run's catalog write, as a listing would make it: at the moment `when` picks, never awaited by the
    // change it lands beside.
    const catalog = () => {
      const servers = owner.servers();
      if (!servers.length) return;
      const s = servers[Math.floor(r2() * servers.length)]!;
      const tools = [{ name: 'echo', fingerprint: `f${++listed}` }];
      if (owner.busy) witness.catalogWhileBusy++;
      void owner.seen(s.setup.id, tools).then(() => {
        if (JSON.stringify(owner.server(s.setup.id)?.tools) === JSON.stringify(tools)) witness.catalogWrites++;
      });
    };
    const notSaved = (v: unknown) => {
      const w = (v as { ok?: boolean; words?: string } | undefined)?.words;
      if ((v as { ok?: boolean } | undefined)?.ok === false && w && /not saved|could not be saved/.test(w)) problems.push(`life ${life}: a change answered "${w}" though nothing else writes`);
    };
    // Seeded changes, each awaited until the life hangs (a change still pending is cut off).
    for (let k = 0; k < 8; k++) {
      const x = r();
      const servers = owner.servers();
      const when = r2();
      if (when < 0.2) catalog();
      let op: Promise<unknown>;
      if (x < 0.35 || !servers.length) {
        const id = `s${++ids}`;
        const setup = r() < 0.5 ? remote(id, `h${Math.floor(r() * 3)}`) : local(id, r() < 0.5 ? ['TOKEN'] : []);
        if (setup.kind === 'local') secretsOf.set(id, setup.secrets.map((n) => `server:${id}:${n}`));
        op = owner.add(setup);
      } else if (x < 0.55) {
        const s = servers[Math.floor(r() * servers.length)]!;
        op = s.setup.kind === 'local' ? owner.edit(s.setup.id, { ...s.setup, label: `${s.setup.label}!`, secrets: r() < 0.5 ? [] : s.setup.secrets }, true) : owner.edit(s.setup.id, { ...s.setup, label: `${s.setup.label}!` }, true);
      } else if (x < 0.8) {
        const s = servers[Math.floor(r() * servers.length)]!;
        op = owner.remove(s.setup.id, async () => {});
      } else {
        const s = servers[Math.floor(r() * servers.length)]!;
        op = owner.choose(s.setup.id, 'echo', r() < 0.5 ? { policy: 'deny', fingerprint: 'f', setupFingerprint: 'g' } : undefined);
      }
      if (when >= 0.2 && when < 0.45) catalog();
      else if (when >= 0.45 && when < 0.7) setTimeout(catalog, 0);
      const done = await Promise.race([op.then((v) => (notSaved(v), true), () => true), new Promise<boolean>((res) => setTimeout(() => res(false), 20))]);
      if (when >= 0.7 && when < 0.85) catalog();
      if (!done) break; // the life is over: this change is cut off where it stood
    }
    await new Promise((res) => setTimeout(res, 0));
    // The life ends here, as a kill ends it: nothing of it reaches the store or the exe after.
    budget.killed = true;
    if (budget.writes.most > 1) problems.push(`life ${life}: ${budget.writes.most} store writes in flight at once`);
  }
  return problems;
}

describe('T3: the owner, across seeded histories with kills', () => {
  it('repairs to a clean state in every history, with nothing orphaned, reused or left undone', async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 300 && problems.length < 6; seed++) for (const p of await history(seed)) problems.push(`seed ${seed}: ${p}`);
    expect(problems).toEqual([]);
    // Witnesses: lives that began with a mark to roll back and with an unfinished tombstone.
    expect(witness.marks).toBeGreaterThan(0);
    expect(witness.tombstones).toBeGreaterThan(0);
    // And catalog writes that landed, and ones that came while a change held the owner.
    expect(witness.catalogWrites).toBeGreaterThan(0);
    expect(witness.catalogWhileBusy).toBeGreaterThan(0);
  }, 300_000);

  it('the control: with no repair at start, the same histories leave marks, orphans or unfinished cleanup', async () => {
    let failed = 0;
    for (let seed = 1; seed <= 100; seed++) if ((await history(seed, false)).length) failed++;
    expect(failed).toBeGreaterThan(0);
  }, 300_000);
});
