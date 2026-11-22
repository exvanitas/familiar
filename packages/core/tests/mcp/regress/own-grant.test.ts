// "May run on its own" (docs/mcp-design.md 5.6, the owner's option A): a grant is the saved choice for one
// exact version. It holds whenever the live tool is exactly that version, back again included, and Familiar
// never clears it; the person's later act wins. The press that writes it is step 8's (the owner's choice, 11-22).
import { describe, expect, it } from 'vitest';
import { BUILT_IN, McpClient } from '../../../src/mcp/client.ts';
import { mintDecision } from '../../../src/mcp/decision.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import { choiceKey } from '../../../src/mcp/server-tools.ts';
import { OWNER_KEY } from '../../../src/mcp/owner.ts';
import { memorySettingsStore } from '../../../src/settings/store.ts';
import { mutations } from '../../../src/mutations.ts';
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
  const writes: { held?: Promise<void>; waiting: number; rejectNext?: boolean; rejectAll?: boolean; tries: number } = { waiting: 0, tries: 0 };
  const inner = memorySettingsStore();
  const store: typeof inner = {
    ...inner,
    putIf: async (k, r, g) => {
      writes.tries++;
      if (writes.rejectAll) {
        // As a real store fails: on a later task.
        await new Promise<void>((r) => setTimeout(r, 0));
        throw new Error('the store keeps failing');
      }
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

/** A decision minted on the grant, as the gate would if its policy still said own; and what came of it. */
async function ownCall(w: Awaited<ReturnType<typeof world>>) {
  const own = mintDecision(w.client.facts('l1', 'echo', {})!, 's', 'own');
  return w.client.send(own, new AbortController().signal);
}



describe("a grant holds for one exact version (5.6, the owner's option A, 11-22)", () => {
  for (const mutation of [undefined, 'own-ignores-fingerprint'] as const)
    it(`granted at A, listed at B: it asks${mutation ? ` (control: ${mutation} runs B unasked)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        const w = await world();
        const a = w.echo()!;
        expect(await w.client.owner.grant('l1', 'echo', { fingerprint: a.fingerprint, setupFingerprint: a.setupFingerprint })).toEqual({ ok: true });
        await w.relist('B');
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

  for (const busy of [false, true] as const)
    it(`A, then B, then A again${busy ? ' (the owner busy while B was listed, its save skipped)' : ''}: it runs on its own at A`, async () => {
      const w = await world();
      const a = w.echo()!;
      expect(await w.client.owner.grant('l1', 'echo', { fingerprint: a.fingerprint, setupFingerprint: a.setupFingerprint })).toEqual({ ok: true });
      const held = busy ? w.client.owner.admit('other') : undefined;
      await w.relist('B');
      if (held && 'release' in held) held.release();
      expect(await ownCall(w)).toMatchObject({ kind: 'error' });
      await w.relist('A');
      expect(w.echo()!.fingerprint).toBe(a.fingerprint);
      expect(w.client.policy(w.client.tools()).perTool).toEqual({ l__echo: 'own' });
      expect(await ownCall(w)).toMatchObject({ kind: 'result' });
      expect(w.calls).toEqual(['A']);
      await w.client.stop('l1');
    });

  it('a tool that leaves the listing and comes back exactly as granted runs on its own again', async () => {
    const w = await world();
    const a = w.echo()!;
    expect(await w.client.owner.grant('l1', 'echo', { fingerprint: a.fingerprint, setupFingerprint: a.setupFingerprint })).toEqual({ ok: true });
    await w.relist(null);
    expect(w.echo()).toBeUndefined();
    await w.relist('A');
    expect(await ownCall(w)).toMatchObject({ kind: 'result' });
    await w.client.stop('l1');
  });

  it('Familiar never clears a grant: B listed and saved, the record still holds A, and a reopen at A runs it', async () => {
    const w = await world();
    const a = w.echo()!;
    expect(await w.client.owner.grant('l1', 'echo', { fingerprint: a.fingerprint, setupFingerprint: a.setupFingerprint })).toEqual({ ok: true });
    await w.relist('B');
    await sleep(40);
    const saved = (await w.store.get(OWNER_KEY))!.value as { servers: Record<string, { tools: { fingerprint: string }[] }>; choices: Record<string, unknown> };
    expect(saved.servers.l1!.tools.map((t) => t.fingerprint)).toEqual([w.echo()!.fingerprint]);
    expect(saved.choices[choiceKey('l1', 'echo')]).toMatchObject({ policy: 'own', fingerprint: a.fingerprint });
    await w.client.stop('l1');
    w.state.desc = 'A';
    const again = await w.reopen();
    expect((await again.start('l1')).kind).toBe('ready');
    expect(again.policy(again.tools()).perTool).toEqual({ l__echo: 'own' });
    await again.stop('l1');
  });

  it("the grant is written from the card's own facts: saved even when the server has moved on, holding only at that version", async () => {
    const w = await world();
    const a = w.echo()!;
    await w.relist('B');
    expect(await w.client.owner.grant('l1', 'echo', { fingerprint: a.fingerprint, setupFingerprint: a.setupFingerprint })).toEqual({ ok: true });
    expect(w.client.choices()[choiceKey('l1', 'echo')]).toMatchObject({ policy: 'own', fingerprint: a.fingerprint });
    expect(await ownCall(w)).toMatchObject({ kind: 'error' });
    await w.relist('A');
    expect(await ownCall(w)).toMatchObject({ kind: 'result' });
    await w.client.stop('l1');
  });

  it('a take-back made while the grant saves holds: the later act wins', async () => {
    const w = await world();
    const a = w.echo()!;
    let release!: () => void;
    w.writes.held = new Promise<void>((r) => (release = r));
    const granting = w.client.owner.grant('l1', 'echo', { fingerprint: a.fingerprint, setupFingerprint: a.setupFingerprint }).then((r) => (r.ok ? 'saved' : 'not saved'));
    for (let i = 0; i < 100 && !w.writes.waiting; i++) await sleep(2);
    // The take-back holds at once, in memory, whatever the owner is doing.
    await w.client.revoke('l1', 'echo', 'ask');
    w.writes.held = undefined;
    release();
    expect(await granting).toBe('saved');
    await sleep(20);
    expect(w.client.policy(w.client.tools()).perTool).toEqual({ l__echo: 'ask' });
    expect(await ownCall(w)).toMatchObject({ kind: 'error' });
    expect(w.calls).toEqual([]);
    await w.client.stop('l1');
  });

  it("a grant's save is let in while a change's cleanup is unfinished: it changes no setup", async () => {
    const w = await world();
    const a = w.echo()!;
    await w.client.stop('l1');
    // A mark left by a change whose cleanup didn't finish, as a crash leaves it.
    const rec = (await w.store.get(OWNER_KEY))!;
    (rec.value as { mark?: unknown }).mark = { kind: 'remove', server: 'gone' };
    await w.store.put(OWNER_KEY, rec);
    const again = await w.reopen();
    expect(again.owner.mark).toBeTruthy();
    expect(await again.owner.grant('l1', 'echo', { fingerprint: a.fingerprint, setupFingerprint: a.setupFingerprint })).toEqual({ ok: true });
    expect(again.choices()[choiceKey('l1', 'echo')]).toMatchObject({ policy: 'own', fingerprint: a.fingerprint });
  });
});

describe("a grant's writer and the gate (r37; the press itself moves to step 8, the owner's choice 11-22)", () => {
  for (const mutation of [undefined, 'choose-own'] as const)
    it(`"may run on its own" is never a choice: choose(own) is refused (r37 #2)${mutation ? ` (control: ${mutation} saves it, and the call runs)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        const w = await world();
        const a = w.echo()!;
        const direct = w.client.choose('l1', 'echo', { policy: 'own', fingerprint: a.fingerprint, setupFingerprint: a.setupFingerprint });
        if (mutation) {
          await direct;
          expect(await ownCall(w)).toMatchObject({ kind: 'result' });
          return;
        }
        await expect(direct).rejects.toThrow(/saved only from a press on its card/);
        await expect(w.client.owner.choose('l1', 'echo', { policy: 'own', fingerprint: a.fingerprint, setupFingerprint: a.setupFingerprint })).resolves.toMatchObject({ ok: false });
        expect(w.client.choices()[choiceKey('l1', 'echo')]).toBeUndefined();
        await w.client.stop('l1');
      } finally {
        mutations.clear();
      }
    });

  for (const mutation of [undefined, 'grant-after-remove'] as const)
    it(`a grant written after its server was removed writes nothing (r37 #3)${mutation ? ` (control: ${mutation} writes a choice under the removed id)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        const w = await world();
        const a = w.echo()!;
        await w.client.stop('l1');
        expect((await w.client.remove('l1')).kind).toBe('removed');
        const r = await w.client.owner.grant('l1', 'echo', { fingerprint: a.fingerprint, setupFingerprint: a.setupFingerprint });
        const choices = ((await w.store.get(OWNER_KEY))!.value as { choices: Record<string, unknown> }).choices;
        if (mutation) {
          expect(choices[choiceKey('l1', 'echo')]).toBeDefined();
          return;
        }
        expect(r.ok).toBe(false);
        expect(choices[choiceKey('l1', 'echo')]).toBeUndefined();
      } finally {
        mutations.clear();
      }
    });

  it("the gate decides own from the live listing, whatever version a turn's copy of the tool is (r37 #4)", async () => {
    const w = await world();
    const held = w.client.tools();
    await w.relist('B');
    const b = w.echo()!;
    expect(await w.client.owner.grant('l1', 'echo', { fingerprint: b.fingerprint, setupFingerprint: b.setupFingerprint })).toEqual({ ok: true });
    // The turn still holds A's wrapper; the server lists B, which is granted.
    expect(w.client.policy(held).perTool).toEqual({ l__echo: 'own' });
    await w.client.stop('l1');
  });

  it("while a change's cleanup is unfinished, grants and take-backs are let in, and nothing else (r37 #5)", async () => {
    const w = await world();
    const a = w.echo()!;
    await w.client.stop('l1');
    const rec = (await w.store.get(OWNER_KEY))!;
    (rec.value as { mark?: unknown }).mark = { kind: 'remove', server: 'gone' };
    await w.store.put(OWNER_KEY, rec);
    const again = await w.reopen();
    expect(await again.owner.grant('l1', 'echo', { fingerprint: a.fingerprint, setupFingerprint: a.setupFingerprint })).toEqual({ ok: true });
    expect((await again.revoke('l1', 'echo', 'never')).ok).toBe(true);
    // A built-in's Allow is no grant nor take-back: refused until the cleanup finishes.
    await expect(again.choose(BUILT_IN, 'note_add', { policy: 'allow', fingerprint: '', setupFingerprint: '' })).rejects.toThrow(/cleanup didn't finish/);
    // Over the saved never, Settings' ask would loosen it: refused. A take-back to ask leaves never standing,
    // and says so: ok, nothing written (r38 #5).
    await expect(again.choose('l1', 'echo', { policy: 'ask', fingerprint: a.fingerprint, setupFingerprint: a.setupFingerprint })).rejects.toThrow(/cleanup didn't finish/);
    const rev = ((await w.store.get(OWNER_KEY))!.value as { rev: number }).rev;
    expect((await again.revoke('l1', 'echo', 'ask')).ok).toBe(true);
    expect(again.choices()[choiceKey('l1', 'echo')]).toMatchObject({ policy: 'deny' });
    // That take-back wrote nothing: the record's revision is unchanged.
    expect(((await w.store.get(OWNER_KEY))!.value as { rev: number }).rev).toBe(rev);
  });

  it("a choice is read once at the client's entry: a getter that reads deny, then ask, can't loosen a never held in memory (r40 #1)", async () => {
    const w = await world();
    await w.client.stop('l1');
    const rec = (await w.store.get(OWNER_KEY))!;
    (rec.value as { mark?: unknown }).mark = { kind: 'remove', server: 'gone' };
    await w.store.put(OWNER_KEY, rec);
    const again = await w.reopen();
    const busy = again.owner.admit('other', { start: true });
    if (!('release' in busy)) throw new Error('not admitted');
    expect((await again.revoke('l1', 'echo', 'never')).ok).toBe(false);
    busy.release();
    let reads = 0;
    const tricky = { get policy() { return ++reads === 1 ? 'deny' : 'ask'; }, fingerprint: 'f', setupFingerprint: 's' } as unknown as Parameters<typeof again.choose>[2];
    await again.choose('l1', 'echo', tricky).catch(() => undefined);
    expect(reads).toBe(1);
    // Whatever was read is what was checked and saved: never stands, in memory and in the record.
    expect((again as unknown as { overlay: Map<string, string> }).overlay.get(choiceKey('l1', 'echo')) ?? again.choices()[choiceKey('l1', 'echo')]?.policy).toMatch(/never|deny/);
    expect(again.choices()[choiceKey('l1', 'echo')]?.policy).not.toBe('ask');
  });

  it("while a change's cleanup is unfinished, a Settings choice can't loosen a never held in memory (r39 #4)", async () => {
    const w = await world();
    const a = w.echo()!;
    await w.client.stop('l1');
    const rec = (await w.store.get(OWNER_KEY))!;
    (rec.value as { mark?: unknown }).mark = { kind: 'remove', server: 'gone' };
    await w.store.put(OWNER_KEY, rec);
    const again = await w.reopen();
    // A take-back to never whose write the busy owner refuses: never holds in memory only.
    const busy = again.owner.admit('other', { start: true });
    if (!('release' in busy)) throw new Error('not admitted');
    expect((await again.revoke('l1', 'echo', 'never')).ok).toBe(false);
    busy.release();
    // Settings' ask would reopen it to asking: refused while the cleanup stands, and never still holds.
    await expect(again.choose('l1', 'echo', { policy: 'ask', fingerprint: a.fingerprint, setupFingerprint: a.setupFingerprint })).rejects.toThrow(/cleanup didn't finish/);
    expect((again as unknown as { overlay: Map<string, string> }).overlay.get(choiceKey('l1', 'echo'))).toBe('never');
  });
});

describe('a stored choice whose key is no choice key', () => {
  it('is skipped: the listing still works, and a grant still stops on a changed listing', async () => {
    const w = await world();
    const f1 = w.echo()!;
    expect(await w.client.owner.grant('l1', 'echo', { fingerprint: f1.fingerprint, setupFingerprint: f1.setupFingerprint })).toEqual({ ok: true });
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

