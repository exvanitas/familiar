// T3, the owner property (docs/mcp-design.md 5.1 to 5.3, 5.5): seeded histories of adds, edits, removes,
// choices and revokes, driven through `McpClient` as Settings drives them, each life cut off at a seeded
// point where every port and store call after it hangs, as a killed app's would. Store and native steps are
// held a turn now and then, a run's catalog write (`seen`) lands at seeded moments between and inside the
// changes, as runs listing their tools would, and now and then a choice or a revoke isn't awaited, so the
// next one starts while its write is held. Each next life repairs, then the invariants hold:
//   - no mark is left, and no tombstone is unfinished;
//   - the exe's server addresses are exactly the ones remote records hold (no orphan, none missing);
//   - an id or key, once removed, never comes back for another server;
//   - a removed server's secrets were each deleted;
//   - never two store writes in flight, and no change answered "not saved" (nothing else writes) but a
//     revoke the owner refused while busy, which says so;
//   - for every choice key, the reopen loads a choice at least as strict as the last change (a choice or a
//     revoke) answered saved, in the order they were made. A change made after it and never answered is
//     excused: it may have landed.
import { describe, expect, it } from 'vitest';
import { BUILT_IN, McpClient, REVOKE_NOT_SAVED } from '../../src/mcp/client.ts';
import { mutations } from '../../src/mutations.ts';
import { OWNER_KEY, type OwnerPorts } from '../../src/mcp/owner.ts';
import type { ProcessPort } from '../../src/mcp/process.ts';
import { choiceKey } from '../../src/mcp/server-tools.ts';
import type { ServerSetup } from '../../src/mcp/setup.ts';
import { memorySettingsStore, type SettingsStore } from '../../src/settings/store.ts';
import { rng } from '../harness/sched.ts';
import { REPO, testPaths } from './fake.ts';
import { realClock } from './wire-fakes.ts';

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

const local = (id: string, secrets: string[]): ServerSetup => ({ kind: 'local', id, label: `Files ${id}`, program: process.execPath, args: ['files.js'], cwd: REPO, env: [], secrets });
const remote = (id: string, host: string): ServerSetup => ({ kind: 'remote', id, label: `Remote ${id}`, url: `https://${host}.example/mcp`, transport: 'http', headers: [] });

/** The client over the owner's ports: nothing here starts a server, so its process and net ports are never
    used, save forget, which a removal calls. */
function clientOf(p: OwnerPorts): Promise<McpClient> {
  const processes: ProcessPort = { start: () => never, write: () => never, stop: () => never, forget: p.forget };
  return McpClient.open({ store: p.store, processes, net: {} as never, addresses: p.addresses, secrets: p.secrets, clock: realClock, paths: testPaths });
}

/** How strict a policy is: no choice reads as a built-in's default allow, the loosest. */
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
type Strictness = 'allow' | 'ask' | 'deny';

/** One choice or revoke, in the order made: what it asked for, and its answer once it has one. */
interface ChoiceChange {
  readonly at: Strictness;
  readonly what: string;
  answer?: 'saved' | 'not saved';
}

const witness = { marks: 0, tombstones: 0, catalogWrites: 0, catalogWhileBusy: 0, overlapping: 0, strictChecks: 0 };

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
  // Every choice and revoke by key, across lives, in the order made.
  const changes = new Map<string, ChoiceChange[]>();
  let pending = 0;
  for (let life = 1; life <= 4; life++) {
    // Each life runs until its budget of port and store calls is spent, then hangs.
    const budget: Budget = { left: life === 4 ? Infinity : 5 + Math.floor(r() * 60), hold: () => r2() < 0.3, writes: { now: 0, most: 0 } };
    const client = await Promise.race([clientOf(ports(store, exe, budget)).catch(() => undefined), new Promise<undefined>((res) => setTimeout(() => res(undefined), 20))]);
    if (!client) {
      budget.killed = true;
      continue; // the life died while opening
    }
    const owner = client.owner;
    // The reopen loads, for every key, a choice at least as strict as the last change answered saved.
    const loaded = owner.choices();
    for (const [key, list] of changes) {
      const last = list.map((c) => c.answer).lastIndexOf('saved');
      if (last < 0 || list.slice(last + 1).some((c) => c.answer === undefined)) continue;
      const [server] = JSON.parse(key) as [string, string];
      if (server !== BUILT_IN && (!owner.server(server) || owner.server(server)!.removing || owner.tombstones()[server])) continue;
      witness.strictChecks++;
      const now = loaded[key]?.policy ?? 'allow';
      if (RANK[now]! < RANK[list[last]!.at]!) problems.push(`life ${life}: ${key} loads ${now}, looser than ${list[last]!.what}, the last change answered saved`);
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
    let sameKey: string | undefined;
    for (let k = 0; k < 8; k++) {
      const x = r();
      const servers = owner.servers();
      const when = r2();
      if (when < 0.2) catalog();
      let op: Promise<unknown>;
      // After a change left unanswered, the next is often a choice or revoke on the same key.
      const choosing = servers.length > 0 && (x >= 0.8 || (sameKey !== undefined && r() < 0.8));
      if (!choosing && (x < 0.35 || !servers.length)) {
        const id = `s${++ids}`;
        const setup = r() < 0.5 ? remote(id, `h${Math.floor(r() * 3)}`) : local(id, r() < 0.5 ? ['TOKEN'] : []);
        if (setup.kind === 'local') secretsOf.set(id, setup.secrets.map((n) => `server:${id}:${n}`));
        op = client.add({ setup, problems: [] }).then(() => ({ ok: true }), (e: Error) => ({ ok: false, words: e.message }));
      } else if (!choosing && x < 0.55) {
        const s = servers[Math.floor(r() * servers.length)]!;
        const setup = s.setup.kind === 'local' ? { ...s.setup, label: `${s.setup.label}!`, secrets: r() < 0.5 ? [] : s.setup.secrets } : { ...s.setup, label: `${s.setup.label}!` };
        op = client.edit(s.setup.id, { setup, problems: [] }).then(() => ({ ok: true }), (e: Error) => ({ ok: false, words: e.message }));
      } else if (!choosing) {
        const s = servers[Math.floor(r() * servers.length)]!;
        op = client.remove(s.setup.id).then((v) => (v.kind === 'removed' ? { ok: true } : { ok: false, words: v.kind === 'failed' ? v.failure.words : v.kind }));
      } else {
        // A choice or a revoke, on a built-in or a server's tool. Now and then it isn't awaited, so the next
        // change starts while its write may be held; and that next change often takes the same key.
        const onServer = r() < 0.4;
        const s = servers[Math.floor(r() * servers.length)]!;
        const [server, tool] = onServer ? [s.setup.id, 'echo'] : [BUILT_IN, r() < 0.5 ? 'note_add' : 'note_search'];
        const following = sameKey !== undefined && r() < 0.8;
        const key = following ? sameKey! : choiceKey(server, tool);
        const [ks, kt] = JSON.parse(key) as [string, string];
        // A change that follows one left unanswered is most often a revoke, as a person taking back what
        // they just chose would make it.
        const list = changes.get(key) ?? [];
        const y = following && r() < 0.7 ? 0.55 + r() * 0.45 : r();
        const change: ChoiceChange =
          y < 0.3 ? { at: 'allow', what: 'choose allow' } : y < 0.4 ? { at: 'ask', what: 'choose ask' } : y < 0.55 ? { at: 'deny', what: 'choose never' } : y < 0.85 ? { at: 'ask', what: 'revoke ask' } : { at: 'deny', what: 'revoke never' };
        changes.set(key, list);
        list.push(change);
        if (pending) witness.overlapping++;
        const made: Promise<{ ok: boolean; words?: string }> = change.what.startsWith('revoke')
          ? client.revoke(ks, kt, change.at === 'deny' ? 'never' : 'ask')
          : client.choose(ks, kt, { policy: change.at, fingerprint: 'f', setupFingerprint: 'g' }).then(
              () => ({ ok: true }),
              (e: Error) => ({ ok: false, words: e.message })
            );
        pending++;
        op = made.then((v) => {
          pending--;
          change.answer = v.ok ? 'saved' : 'not saved';
          // A revoke the owner refused says so; its own reason is busy or a change unfinished, never lost.
          return v.ok || !change.what.startsWith('revoke') ? v : { ok: false, words: v.words?.startsWith(REVOKE_NOT_SAVED) ? v.words.slice(REVOKE_NOT_SAVED.length) : v.words };
        });
        sameKey = key;
        if (r2() < 0.5) {
          void op.then(notSaved);
          continue;
        }
      }
      sameKey = undefined;
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
    for (let seed = 1; seed <= 400 && problems.length < 6; seed++) for (const p of await history(seed)) problems.push(`seed ${seed}: ${p}`);
    expect(problems).toEqual([]);
    // Witnesses: lives that began with a mark to roll back and with an unfinished tombstone.
    expect(witness.marks).toBeGreaterThan(0);
    expect(witness.tombstones).toBeGreaterThan(0);
    // And catalog writes that landed, and ones that came while a change held the owner.
    expect(witness.catalogWrites).toBeGreaterThan(0);
    expect(witness.catalogWhileBusy).toBeGreaterThan(0);
    // And changes made while an earlier one was unanswered, and reopens that checked a key's strictness.
    expect(witness.overlapping).toBeGreaterThan(0);
    expect(witness.strictChecks).toBeGreaterThan(0);
  }, 300_000);

  it("the control: a revoke to Ask over a saved never answered saved at once, while an earlier choice's write is held (the old shortcut), fails the strictness invariant on a seed where its twin passes", async () => {
    const tried: string[] = [];
    try {
      // The defect needs a saved never, a choice of allow admitted and left unanswered, then a revoke to Ask
      // on the same key: the first seed with all three is past 300.
      for (let seed = 1; seed <= 1000; seed++) {
        mutations.set(['revoke-denied-shortcut']);
        const mutant = await history(seed);
        const hits = mutations.hits('revoke-denied-shortcut');
        mutations.clear();
        if (!hits || !mutant.some((p) => /looser than/.test(p))) continue;
        const twin = await history(seed);
        tried.push(`seed ${seed}: twin ${twin.length ? `fails (${twin[0]})` : 'passes'}`);
        if (!twin.length) return;
      }
    } finally {
      mutations.clear();
    }
    expect.fail(`revoke-denied-shortcut: no seed where the strictness invariant fails only in the mutant (${tried.slice(0, 4).join('; ') || 'the switch never fired or the invariant never failed'})`);
  }, 300_000);

  it('the control: with no repair at start, the same histories leave marks, orphans or unfinished cleanup', async () => {
    let failed = 0;
    for (let seed = 1; seed <= 100; seed++) if ((await history(seed, false)).length) failed++;
    expect(failed).toBeGreaterThan(0);
  }, 300_000);
});
