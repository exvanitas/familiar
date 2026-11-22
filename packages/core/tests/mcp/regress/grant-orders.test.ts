// "May run on its own" across every interleaving of the person's acts and the owner's writes (5.6, option A;
// the lead's ruling on r37). Each run drives the real client and owner over a store whose writes are held until
// a flush, through one order of: the press, the journal's commit (the save), a take-back to never, the
// server's removal, a catalog save (a new listing), and flushes. Three invariants, each with a control that
// must fail the walk:
// - the latest act wins: a take-back after the press is never undone by it (control own-press-order-late);
// - nothing saves "own" without a press (choose-own);
// - nothing writes a choice under a removed server (grant-after-remove).
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../../src/mcp/client.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import { choiceKey } from '../../../src/mcp/server-tools.ts';
import { OWNER_KEY } from '../../../src/mcp/owner.ts';
import { memorySettingsStore } from '../../../src/settings/store.ts';
import { mutations } from '../../../src/mutations.ts';
import { testPaths, REPO } from '../fake.ts';
import { initResult, realClock, textResult } from '../wire-fakes.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const setup = { kind: 'local' as const, id: 'l1', label: 'L', program: process.execPath, args: ['x.js'], cwd: REPO, env: [], secrets: [] };
const KEY = choiceKey('l1', 'echo');

type Step = 'press' | 'save' | 'take-back' | 'remove' | 'catalog' | 'flush' | 'forge';

/** One run: a fresh client, the steps in order, then everything settled; what the invariants read. */
async function run(steps: readonly Step[]) {
  let emit!: (e: ProcessEvent) => void;
  const state = { desc: 'A' };
  const writes = { holding: false, pending: [] as (() => void)[] };
  const inner = memorySettingsStore();
  const store: typeof inner = {
    ...inner,
    putIf: async (k, r, g) => {
      if (writes.holding) await new Promise<void>((res) => writes.pending.push(res));
      return inner.putIf(k, r, g);
    }
  };
  const port: ProcessPort = {
    async start(_s, on) {
      emit = on;
      return { run: 'p1' };
    },
    async write(_r, b) {
      const m = JSON.parse(new TextDecoder().decode(b));
      queueMicrotask(() => {
        if (m.method === 'initialize') emit({ t: 'out', line: JSON.stringify(initResult(m.id)) });
        if (m.method === 'tools/list') emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: state.desc, inputSchema: { type: 'object', properties: {} } }] } }) });
        if (m.method === 'tools/call') emit({ t: 'out', line: JSON.stringify(textResult(m.id, 'ran')) });
      });
    },
    async stop() {
      queueMicrotask(() => emit({ t: 'exit', code: 0 }));
    },
    async forget() {}
  };
  const client = await McpClient.open({ store, processes: port, net: {} as never, addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: realClock, paths: testPaths });
  await client.add({ setup, problems: [] });
  expect((await client.start('l1')).kind).toBe('ready');
  const a = client.tools().find((t) => t.serverName === 'echo')!;
  writes.holding = true;
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      writes.pending.splice(0).forEach((f) => f());
      await sleep(2);
      if (!writes.pending.length) break;
    }
  };
  const order: Step[] = [];
  let press: { save(): Promise<boolean> } | undefined;
  const settled: Promise<unknown>[] = [];
  const out: { saved?: boolean; takeBackOk?: boolean; removed?: boolean } = {};
  for (const step of steps) {
    order.push(step);
    if (step === 'press') press = client.pressOwn({ server: 'l1', tool: 'echo', fingerprint: a.fingerprint, launch: a.setupFingerprint });
    else if (step === 'save') settled.push(press!.save().then((ok) => (out.saved = ok)));
    else if (step === 'take-back') settled.push(client.revoke('l1', 'echo', 'never').then((r) => (out.takeBackOk = r.ok)));
    else if (step === 'remove') settled.push(client.stop('l1').then(() => client.remove('l1')).then((r) => (out.removed = r.kind === 'removed')));
    else if (step === 'catalog') {
      state.desc = 'B';
      emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) });
      await sleep(5);
    } else if (step === 'forge') settled.push(client.choose('l1', 'echo', { policy: 'own', fingerprint: a.fingerprint, setupFingerprint: a.setupFingerprint }).catch(() => undefined));
    else await flush();
  }
  // Everything settles: no write held, every act answered.
  writes.holding = false;
  writes.pending.splice(0).forEach((f) => f());
  await Promise.all(settled);
  await sleep(10);
  const record = ((await inner.get(OWNER_KEY))!.value as { choices: Record<string, { policy: string }> }).choices[KEY];
  const live = client.tools().find((t) => t.serverName === 'echo');
  const gate = live ? client.policy([live]).perTool?.[live.name] : undefined;
  return { steps, out, record, gate, live: live?.fingerprint === a.fingerprint };
}

/** The invariants over one run's outcome: the problems, or none. */
function problems(r: Awaited<ReturnType<typeof run>>): string[] {
  const p: string[] = [];
  const at = (s: Step) => r.steps.indexOf(s);
  const pressed = at('press') >= 0;
  // The latest act wins. A take-back after the press holds: never own in the gate; and once it said it was
  // saved, never own in the record either.
  if (pressed && at('take-back') > at('press')) {
    if (r.gate === 'own') p.push('a take-back after the press lost in the gate');
    if (r.out.takeBackOk && r.record?.policy === 'own') p.push('a take-back said saved, then an older press wrote own');
  }
  // And a press after a take-back, once saved, holds while its version is listed.
  if (pressed && at('take-back') >= 0 && at('take-back') < at('press') && r.out.saved && r.live && !r.out.removed && r.gate !== 'own') p.push('a press after the take-back, saved, did not hold');
  // Nothing saves own without a press that resolved saved.
  if (r.record?.policy === 'own' && r.out.saved !== true) p.push('own in the record with no press saved');
  // Nothing writes under a removed server.
  if (r.out.removed && r.record !== undefined) p.push('a choice written under the removed server');
  return p;
}

/** Every subset of the optional steps, each with the steps every run has, in every order. */
function walks(always: readonly Step[], optional: readonly Step[]): Step[][] {
  const out: Step[][] = [];
  for (let m = 0; m < 1 << optional.length; m++) out.push(...orders([...always, ...optional.filter((_, i) => m & (1 << i))]));
  return out;
}

/** Every order of a multiset of steps, the press before its save. */
function orders(steps: readonly Step[]): Step[][] {
  const out: Step[][] = [];
  const go = (left: Step[], acc: Step[]) => {
    if (!left.length) {
      if (acc.indexOf('press') <= acc.indexOf('save')) out.push(acc);
      return;
    }
    const seen = new Set<Step>();
    left.forEach((s, i) => {
      if (seen.has(s)) return;
      seen.add(s);
      go([...left.slice(0, i), ...left.slice(i + 1)], [...acc, s]);
    });
  };
  go([...steps], []);
  return out;
}

const OPTIONAL: Step[] = ['take-back', 'remove', 'catalog'];
const PRESS_WALK = walks(['press', 'save', 'flush', 'flush'], OPTIONAL);
const FORGE_WALK = walks(['forge', 'flush'], OPTIONAL);

async function walk(all: readonly Step[][], stopAtFirst: boolean) {
  const bad: string[] = [];
  // What the walk reached, so a clean walk is no empty one: grants saved, own in the gate, take-backs saved.
  const reached = { saved: 0, ownGate: 0, takeBackSaved: 0, removed: 0 };
  for (const o of all) {
    const r = await run(o);
    if (r.out.saved) reached.saved++;
    if (r.gate === 'own') reached.ownGate++;
    if (r.out.takeBackOk) reached.takeBackSaved++;
    if (r.out.removed) reached.removed++;
    const ps = problems(r);
    if (ps.length) {
      bad.push(`${o.join(' → ')}: ${ps.join('; ')}`);
      if (stopAtFirst) break;
    }
  }
  return { runs: all.length, bad, reached };
}

describe('"may run on its own" across every interleaving of the press, its save, a take-back, a removal and a catalog save', () => {
  it('every order of the press walk holds the three invariants', async () => {
    const r = await walk(PRESS_WALK, false);
    // 6 + 3 x 30 + 3 x 180 + 1260 orders.
    expect(r.runs).toBe(1896);
    expect(r.bad, r.bad.slice(0, 5).join('\n')).toEqual([]);
    for (const [what, n] of Object.entries(r.reached)) expect(n, `${what} reached in no order`).toBeGreaterThan(0);
  }, 600_000);

  it('every order of the forged-grant walk holds them too: choose(own) saves nothing', async () => {
    const r = await walk(FORGE_WALK, false);
    expect(r.runs).toBe(2 + 3 * 6 + 3 * 24 + 120);
    expect(r.bad, r.bad.slice(0, 5).join('\n')).toEqual([]);
  }, 300_000);

  for (const [mutation, steps] of [['own-press-order-late', PRESS_WALK], ['choose-own', FORGE_WALK], ['grant-after-remove', PRESS_WALK]] as const)
    it(`the control ${mutation} fails the walk`, async () => {
      mutations.set([mutation]);
      try {
        const r = await walk(steps, true);
        expect(r.bad.length, `${mutation}: no order broke an invariant`).toBeGreaterThan(0);
      } finally {
        mutations.clear();
      }
    }, 600_000);
});
