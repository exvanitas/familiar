// "May run on its own" (docs/mcp-design.md 5.6): the grant holds only for the listing it was given on. A tool
// that changes and changes back asks again, even when the catalog write was skipped; and the button counts
// only on the card showing now, whose facts still hold.
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../../src/mcp/client.ts';
import { mintDecision } from '../../../src/mcp/decision.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import { choiceKey } from '../../../src/mcp/server-tools.ts';
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
  const state = { desc: 'A' };
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
        if (m.method === 'tools/list') emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: state.desc, inputSchema: { type: 'object', properties: {} } }] } }) });
        if (m.method === 'tools/call') {
          calls.push(state.desc);
          emit({ t: 'out', line: JSON.stringify(textResult(m.id, 'ran')) });
        }
      });
    },
    async stop() {
      queueMicrotask(() => emit({ t: 'exit', code: 0 }));
    },
    async forget() {}
  };
  const client = await McpClient.open({ store: memorySettingsStore(), processes: port, net: {} as never, addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: realClock, paths: testPaths });
  await client.add({ setup, problems: [] });
  expect((await client.start('l1')).kind).toBe('ready');
  const relist = async (desc: string) => {
    const was = client.tools()[0]!.fingerprint;
    state.desc = desc;
    emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) });
    for (let i = 0; i < 200 && client.tools()[0]?.fingerprint === was; i++) await sleep(5);
    await sleep(10);
  };
  return { client, calls, relist, state };
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
        expect(w.client.policy(w.client.tools()).perTool).toEqual({ l__echo: 'ask' });
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
