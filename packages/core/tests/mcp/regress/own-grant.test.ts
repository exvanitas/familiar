// "May run on its own" (docs/mcp-design.md 5.6): the grant holds only for the listing it was given on. A tool
// that changes and changes back asks again, even when the catalog write was skipped; and the button counts
// only on the card showing now, whose facts still hold.
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../../src/mcp/client.ts';
import { mintDecision } from '../../../src/mcp/decision.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import { choiceKey } from '../../../src/mcp/server-tools.ts';
import { OWNER_KEY } from '../../../src/mcp/owner.ts';
import { memorySettingsStore } from '../../../src/settings/store.ts';
import { mutations } from '../../../src/mutations.ts';
import { createCardDesk, decideByRules, openJournal, systemClock, type ModelRequest } from '../../../src/index.ts';
import { createFakeModel } from '../../../src/testing/index.ts';
import { nodeWorld } from '../../journal/node-env.ts';
import { testPaths, REPO } from '../fake.ts';
import { initResult, realClock, textResult } from '../wire-fakes.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const setup = { kind: 'local' as const, id: 'l1', label: 'L', program: process.execPath, args: ['x.js'], cwd: REPO, env: [], secrets: [] };

/** A local server whose echo is described `desc()`; a notice of changed tools on demand. */
async function world() {
  let emit!: (e: ProcessEvent) => void;
  // desc null: the server lists no echo at all.
  const state: { desc: string | null; other?: string } = { desc: 'A' };
  // A gate on the owner's writes: while `held` is set, each write waits for its release.
  const writes: { held?: Promise<void>; waiting: number; rejectNext?: boolean } = { waiting: 0 };
  const inner = memorySettingsStore();
  const store: typeof inner = {
    ...inner,
    putIf: async (k, r, g) => {
      if (writes.rejectNext) {
        writes.rejectNext = false;
        throw new Error('the store failed once');
      }
      if (writes.held) {
        writes.waiting++;
        await writes.held;
      }
      return inner.putIf(k, r, g);
    }
  };
  const calls: string[] = [];
  const port: ProcessPort = {
    async start(_s, on) {
      emit = on;
      return { run: 'p1' };
    },
    async write(_r, b) {
      const m = JSON.parse(new TextDecoder().decode(b));
      queueMicrotask(() => {
        if (m.method === 'initialize') emit({ t: 'out', line: JSON.stringify(initResult(m.id)) });
        if (m.method === 'tools/list') {
          const other = { name: 'other', description: state.other ?? 'O', inputSchema: { type: 'object', properties: {} } };
          const tools = state.desc === null ? [other] : [{ name: 'echo', description: state.desc, inputSchema: { type: 'object', properties: {} } }, ...(state.other !== undefined ? [other] : [])];
          emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools } }) });
        }
        if (m.method === 'tools/call') {
          calls.push(String(state.desc));
          emit({ t: 'out', line: JSON.stringify(textResult(m.id, 'ran')) });
        }
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
  const relist = async (desc: string | null, other?: string) => {
    const was = JSON.stringify(client.tools().map((t) => t.fingerprint));
    state.desc = desc;
    if (other !== undefined) state.other = other;
    emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) });
    for (let i = 0; i < 200 && JSON.stringify(client.tools().map((t) => t.fingerprint)) === was; i++) await sleep(5);
    await sleep(10);
  };
  const echo = () => client.tools().find((t) => t.serverName === 'echo');
  const reopen = () => McpClient.open({ store, processes: port, net: {} as never, addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: realClock, paths: testPaths });
  return { client, calls, relist, state, writes, echo, store, reopen };
}

describe('a grant and a tool that changes and changes back', () => {
  for (const mutation of [undefined, 'own-kept-on-skip'] as const)
    it(`F1, then F2 while the owner is busy (the catalog write skipped), then F1 again: it asks${mutation ? ` (control: ${mutation} runs it unasked)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        const w = await world();
        const f1 = w.client.tools()[0]!;
        await w.client.choose('l1', 'echo', { policy: 'own', fingerprint: f1.fingerprint, setupFingerprint: f1.setupFingerprint });
        const busy = w.client.owner.admit('other');
        if (!('release' in busy)) throw new Error('not admitted');
        await w.relist('B');
        busy.release();
        await w.relist('A');
        expect(w.client.tools()[0]!.fingerprint).toBe(f1.fingerprint);
        // A decision minted on the grant, as the gate would if its policy still said own.
        const own = mintDecision(w.client.facts('l1', 'echo', {})!, 's', 'own');
        const out = await w.client.send(own, new AbortController().signal);
        if (mutation) {
          expect(out).toMatchObject({ kind: 'result' });
          return;
        }
        expect(w.client.policy(w.client.tools()).perTool).toEqual({});
        expect(out).toMatchObject({ kind: 'error', words: expect.stringMatching(/no longer stands/) });
        expect(w.calls).toEqual([]);
        // And cleared for good once the owner was free.
        for (let i = 0; i < 100 && w.client.choices()[choiceKey('l1', 'echo')]; i++) await sleep(5);
        expect(w.client.choices()[choiceKey('l1', 'echo')]).toBeUndefined();
        await w.client.stop('l1');
      } finally {
        mutations.clear();
      }
    });
});

/** A decision minted on the grant, as the gate would if its policy still said own; and what came of it. */
async function ownCall(w: Awaited<ReturnType<typeof world>>) {
  const own = mintDecision(w.client.facts('l1', 'echo', {})!, 's', 'own');
  return w.client.send(own, new AbortController().signal);
}

describe('a listing while the grant itself saves', () => {
  for (const mutation of [undefined, 'own-counter-ignored'] as const)
    it(`F2 listed during the grant's own save, then F1 again: it asks${mutation ? ` (control: ${mutation} runs it unasked)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        const w = await world();
        const f1 = w.echo()!;
        let release!: () => void;
        w.writes.held = new Promise<void>((r) => (release = r));
        const granting = w.client.choose('l1', 'echo', { policy: 'own', fingerprint: f1.fingerprint, setupFingerprint: f1.setupFingerprint }).then(() => 'saved', (e: Error) => e.message);
        for (let i = 0; i < 100 && !w.writes.waiting; i++) await sleep(2);
        expect(w.writes.waiting).toBe(1);
        await w.relist('B');
        w.writes.held = undefined;
        release();
        expect(await granting).toBe('saved');
        await w.relist('A');
        expect(w.echo()!.fingerprint).toBe(f1.fingerprint);
        const out = await ownCall(w);
        if (mutation) {
          expect(out).toMatchObject({ kind: 'result' });
          return;
        }
        expect(w.client.policy(w.client.tools()).perTool).toEqual({});
        expect(out).toMatchObject({ kind: 'error' });
        expect(w.calls).toEqual([]);
        for (let i = 0; i < 100 && w.client.choices()[choiceKey('l1', 'echo')]; i++) await sleep(5);
        expect(w.client.choices()[choiceKey('l1', 'echo')]).toBeUndefined();
        await w.client.stop('l1');
      } finally {
        mutations.clear();
      }
    });

  for (const mutation of [undefined, 'own-grant-unchecked'] as const)
    it(`a grant for a version not listed now is refused, and nothing is saved${mutation ? ` (control: ${mutation} saves it)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        const w = await world();
        const f1 = w.echo()!;
        await w.relist('B');
        const stale = w.client.choose('l1', 'echo', { policy: 'own', fingerprint: f1.fingerprint, setupFingerprint: f1.setupFingerprint });
        if (mutation) {
          await stale;
          expect(w.client.choices()[choiceKey('l1', 'echo')]).toMatchObject({ policy: 'own', fingerprint: f1.fingerprint });
          return;
        }
        await expect(stale).rejects.toThrow(/changed/);
        await expect(w.client.choose('l1', 'echo', { policy: 'own', fingerprint: w.echo()!.fingerprint, setupFingerprint: 'another setup' })).rejects.toThrow(/changed/);
        expect(w.client.choices()[choiceKey('l1', 'echo')]).toBeUndefined();
        await w.client.stop('l1');
      } finally {
        mutations.clear();
      }
    });
});

describe('a tool that leaves the listing and comes back', () => {
  for (const mutation of [undefined, 'own-kept-on-absence'] as const)
    it(`granted at F1, a listing without it, then F1 again: it asks${mutation ? ` (control: ${mutation} runs it unasked)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        const w = await world();
        const f1 = w.echo()!;
        await w.client.choose('l1', 'echo', { policy: 'own', fingerprint: f1.fingerprint, setupFingerprint: f1.setupFingerprint });
        await w.relist(null);
        expect(w.echo()).toBeUndefined();
        await w.relist('A');
        expect(w.echo()!.fingerprint).toBe(f1.fingerprint);
        const out = await ownCall(w);
        if (mutation) {
          expect(out).toMatchObject({ kind: 'result' });
          return;
        }
        expect(w.client.policy(w.client.tools()).perTool).toEqual({});
        expect(out).toMatchObject({ kind: 'error' });
        expect(w.calls).toEqual([]);
        await w.client.stop('l1');
      } finally {
        mutations.clear();
      }
    });
});

describe('the button counts only on the card showing now', () => {
  for (const mutation of [undefined, 'own-on-stale-card'] as const)
    it(`Own pressed on A's card after the server published B saves no grant${mutation ? ` (control: ${mutation} saves A's)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        const w = await world();
        const fpA = w.client.tools()[0]!.fingerprint;
        const granted: string[] = [];
        const grant = async (facts: { fingerprint: string; server: string; tool: string; launch: string }) => {
          granted.push(facts.fingerprint);
          await w.client.choose(facts.server, facts.tool, { policy: 'own', fingerprint: facts.fingerprint, setupFingerprint: facts.launch });
          return true;
        };
        // The desk's own callback, as the app would have wired it before the journal took the grant over: the
        // desk now ignores it, and the journal's grantOwn is the only way a grant is saved.
        const desk = (createCardDesk as (o?: unknown) => ReturnType<typeof createCardDesk>)({ onOwn: (card: { facts: Parameters<typeof grant>[0] }) => void grant(card.facts) });
        let held = w.client.tools();
        const model = createFakeModel((r: ModelRequest) => (r.messages.at(-1)?.role === 'tool' ? { text: 'Done.' } : { text: 'On it.', toolCalls: [{ id: `c${r.messages.length}`, name: 'l__echo', arguments: {} }] }));
        const nw = nodeWorld();
        const j = await openJournal({
          store: await nw.open(`own-stale-${mutation ?? 'twin'}`),
          owner: nw.owner,
          model,
          modelId: 'fake-1',
          caps: { config: { maxReplyTokens: 200 }, call: { persona: 'o', price: { inputPerMTok: 1, outputPerMTok: 2 } } },
          tools: held,
          clock: systemClock,
          wake: { wakeAt: () => {} },
          consent: desk.port,
          grantOwn: grant,
          policy: () => w.client.policy(held),
          presence: { report: () => {} },
          persona: { id: 'o', name: 'O', instructions: 'x' },
          decider: { decide: async (e, c) => decideByRules(e, c) },
          ambient: () => ({ persona: { sketch: 'k', interests: [] }, chattiness: 'medium', doNotDisturb: false, fullscreen: false, sentAway: false, chatInFront: true, teaserDue: false }),
          resendDelayMs: 50,
          notifier: { notify: () => {} }
        });
        const t1 = await j.send('Echo.', 't1');
        for (let i = 0; i < 200 && !desk.showing().length; i++) await sleep(5);
        const cardA = desk.showing()[0]!.card;
        await w.relist('B');
        held = w.client.tools();
        desk.answer({ presentation: cardA.presentation, button: 'own' });
        for (let i = 0; i < 200 && desk.showing().every((x) => x.card.presentation === cardA.presentation); i++) await sleep(5);
        await sleep(20);
        for (const x of desk.showing()) desk.answer({ presentation: x.card.presentation, button: 'skip' });
        if (t1.replied) await t1.turn.wait();
        if (mutation) expect(granted).toEqual([fpA]);
        else {
          expect(granted).toEqual([]);
          expect(w.client.choices()[choiceKey('l1', 'echo')]).toBeUndefined();
          // The card's words say the grant follows the listing.
          expect(cardA.own).toMatch(/asks again/);
        }
        await j.close();
        await w.client.stop('l1');
      } finally {
        mutations.clear();
      }
    });
});

describe('a stored choice whose key is no choice key', () => {
  it('is skipped: the listing still works, and a grant still stops on a changed listing', async () => {
    const w = await world();
    const f1 = w.echo()!;
    await w.client.choose('l1', 'echo', { policy: 'own', fingerprint: f1.fingerprint, setupFingerprint: f1.setupFingerprint });
    await w.client.stop('l1');
    // Keys that aren't JSON, or aren't a [server, tool] pair, beside the real grant, carrying an own choice.
    const rec = (await w.store.get(OWNER_KEY))!;
    const value = rec.value as { choices: Record<string, unknown> };
    const grant = value.choices[choiceKey('l1', 'echo')];
    expect(grant).toMatchObject({ policy: 'own' });
    value.choices['{not json'] = grant;
    value.choices['["l1"]'] = grant;
    await w.store.put(OWNER_KEY, rec);
    const client = await w.reopen();
    expect((await client.start('l1')).kind).toBe('ready');
    expect(client.policy(client.tools()).perTool).toEqual({ l__echo: 'own' });
    // A changed listing still stops the real grant.
    w.state.desc = 'B';
    const was = client.tools()[0]!.fingerprint;
    (client as unknown as { runtimes: Map<string, { link: { list(): Promise<unknown> } }> }).runtimes.get('l1')!.link.list();
    for (let i = 0; i < 200 && client.tools()[0]?.fingerprint === was; i++) await sleep(5);
    await sleep(10);
    expect(client.tools()[0]!.fingerprint).not.toBe(was);
    expect(client.policy(client.tools()).perTool).toEqual({});
    await client.stop('l1');
  });
});

describe('publications the machine coalesces into one catalog save', () => {
  for (const mutation of [undefined, 'own-counter-ignored'] as const)
    it(`granted at F1; another tool's save held; F2, then F1 published: it asks${mutation ? ` (control: ${mutation} runs it unasked)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        const w = await world();
        await w.relist('A', 'O1');
        const f1 = w.echo()!;
        await w.client.choose('l1', 'echo', { policy: 'own', fingerprint: f1.fingerprint, setupFingerprint: f1.setupFingerprint });
        let release!: () => void;
        w.writes.held = new Promise<void>((r) => (release = r));
        await w.relist('A', 'O2');
        await w.relist('B');
        await w.relist('A');
        w.writes.held = undefined;
        release();
        await sleep(30);
        expect(w.echo()!.fingerprint).toBe(f1.fingerprint);
        const out = await ownCall(w);
        if (mutation) {
          expect(out).toMatchObject({ kind: 'result' });
          return;
        }
        expect(w.client.policy(w.client.tools()).perTool).toEqual({});
        expect(out).toMatchObject({ kind: 'error' });
        expect(w.calls).toEqual([]);
        await w.client.stop('l1');
      } finally {
        mutations.clear();
      }
    });
});

describe('two grant attempts', () => {
  for (const mutation of [undefined, 'own-counter-ignored'] as const)
    it(`the first's save held, a second refused, F2 then F1 listed: the first asks once saved${mutation ? ` (control: ${mutation} runs it unasked)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        const w = await world();
        const f1 = w.echo()!;
        let release!: () => void;
        w.writes.held = new Promise<void>((r) => (release = r));
        const grant = () => w.client.choose('l1', 'echo', { policy: 'own', fingerprint: f1.fingerprint, setupFingerprint: f1.setupFingerprint }).then(() => 'saved', (e: Error) => e.message);
        const first = grant();
        for (let i = 0; i < 100 && !w.writes.waiting; i++) await sleep(2);
        expect(await grant()).toMatch(/Saving another change/);
        await w.relist('B');
        await w.relist('A');
        w.writes.held = undefined;
        release();
        expect(await first).toBe('saved');
        await sleep(30);
        const out = await ownCall(w);
        if (mutation) {
          expect(out).toMatchObject({ kind: 'result' });
          return;
        }
        expect(out).toMatchObject({ kind: 'error' });
        expect(w.calls).toEqual([]);
        await w.client.stop('l1');
      } finally {
        mutations.clear();
      }
    });
});

describe("a grant's durable clear", () => {
  for (const mutation of [undefined, 'clear-dropped-on-error'] as const)
    it(`whose write fails once is kept and lands later: a reopen at F1 asks${mutation ? ` (control: ${mutation} loses it, and the reopen runs it unasked)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        const w = await world();
        const f1 = w.echo()!;
        await w.client.choose('l1', 'echo', { policy: 'own', fingerprint: f1.fingerprint, setupFingerprint: f1.setupFingerprint });
        const busy = w.client.owner.admit('other');
        if (!('release' in busy)) throw new Error('not admitted');
        await w.relist('B');
        w.writes.rejectNext = true;
        busy.release();
        await sleep(30);
        // No listing since: only the kept clear can land, at the next chance the owner gives (this write).
        await w.client.setEnabled('l1', true);
        await sleep(30);
        await w.client.stop('l1');
        // Back at F1 when Familiar next starts it.
        w.state.desc = 'A';
        const again = await w.reopen();
        expect((await again.start('l1')).kind).toBe('ready');
        const policy = again.policy(again.tools()).perTool;
        if (mutation) expect(policy).toEqual({ l__echo: 'own' });
        else {
          expect(policy).toEqual({});
          expect(again.choices()[choiceKey('l1', 'echo')]).toBeUndefined();
        }
        await again.stop('l1');
      } finally {
        mutations.clear();
      }
    });

  it("on the success path, waits for the catalog write: the changed catalog is saved", async () => {
    const w = await world();
    const f1 = w.echo()!;
    await w.client.choose('l1', 'echo', { policy: 'own', fingerprint: f1.fingerprint, setupFingerprint: f1.setupFingerprint });
    await w.relist('B');
    await sleep(40);
    const saved = (await w.store.get(OWNER_KEY))!.value as { servers: Record<string, { tools: { fingerprint: string }[] }> };
    expect(saved.servers.l1!.tools.map((t) => t.fingerprint)).toEqual([w.echo()!.fingerprint]);
    expect(w.client.choices()[choiceKey('l1', 'echo')]).toBeUndefined();
    await w.client.stop('l1');
  });
});
