// A real server tool in the turn loop, killed mid-call. Life 1: the model calls the fake server's slow
// tool, it's under way, and the app dies (the journal is abandoned and the server's run ends with it).
// Life 2: a new client starts the server again and the journal resumes. The call is reported as
// interrupted, with Run again, and the server never gets it a second time.
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeModel, type FakeReply } from '../../src/testing/index.ts';
import { choiceKey, decideByRules, McpClient, openJournal, parsePaste, systemClock, toolPolicies, type GatePolicy, type ModelRequest, type ServerTool, type ToolChoice } from '../../src/index.ts';
import { memorySettingsStore, type SettingsStore } from '../../src/settings/store.ts';
import { nodeWorld, type NodeWorld } from '../journal/node-env.ts';
import { FAKE_MAIN, REPO, testPaths } from './fake.ts';
import { nodeProcessPort, type NodeProcessPort } from './node-process.ts';
import { nodeNetPort } from './node-net.ts';
import { callWithYes } from '../../src/testing/consent.ts';
import { buttonsOf, createCardDesk, type ConsentCard, type ConsentPort } from '../../src/index.ts';
import { mutations } from '../../src/mutations.ts';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const slowCalls = (port: NodeProcessPort) => port.written.filter(l => l.includes('"tools/call"') && l.includes('"name":"slow"')).length;

async function life(world: NodeWorld, store: SettingsStore, id: string | undefined, script: (r: ModelRequest) => FakeReply, extra: { policy?: () => GatePolicy; ask?: (card: ConsentCard) => boolean | void; consent?: ConsentPort; storeName?: string; choices?: () => Record<string, ToolChoice>; review?: boolean } = {}) {
  const port = nodeProcessPort();
  cleanups.push(() => port.closeAll());
  const client = await McpClient.open({ paths: testPaths, store, processes: port, net: nodeNetPort(), addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: systemClock });
  let serverId = id;
  if (!serverId) {
    const { drafts } = parsePaste(JSON.stringify({ mcpServers: { 'Fake server': { command: process.execPath, args: [FAKE_MAIN] } } }), { newId: () => 'fake-journal', defaultCwd: REPO, paths: testPaths });
    serverId = (await client.add(drafts[0]!)).id;
  }
  // The person's Test and Mark reviewed, while it's stopped: its tools' descriptions are theirs now.
  if (extra.review) {
    const report = await client.test(serverId);
    if (!report.ok) throw new Error('Test failed');
    await client.markReviewed(serverId, report.report, report.tools.map((t) => t.name));
  }
  expect((await client.start(serverId)).kind).toBe('ready');
  const tools = client.tools();
  const { journal, model } = await turnLoop(world, tools, script, extra);
  return { port, client, journal, model, serverId, tools };
}

/** A journal over the given wrappers: the tools a turn loop holds until it's opened again. */
async function turnLoop(world: NodeWorld, tools: ServerTool[], script: (r: ModelRequest) => FakeReply, extra: { policy?: () => GatePolicy; ask?: (card: ConsentCard) => boolean | void; consent?: ConsentPort; storeName?: string } = {}) {
  const model = createFakeModel(script);
  const journal = await openJournal({
    store: await world.open(extra.storeName ?? 'mcp-kill'),
    owner: world.owner,
    model,
    modelId: 'fake-1',
    caps: { config: { maxReplyTokens: 200 }, call: { persona: 'olive', price: { inputPerMTok: 1, outputPerMTok: 2 } } },
    tools,
    clock: systemClock,
    wake: { wakeAt: () => {} },
    consent: extra.consent ?? { ask: (card) => Promise.resolve(extra.ask?.(card) ?? true) },
    ...(extra.policy ? { policy: extra.policy } : {}),
    presence: { report: () => {} },
    persona: { id: 'olive', name: 'Olive', instructions: 'You are Olive.' },
    decider: { decide: async (event, context) => decideByRules(event, context) },
    ambient: () => ({ persona: { sketch: 'kind', interests: [] }, chattiness: 'medium', doNotDisturb: false, fullscreen: false, sentAway: false, chatInFront: true, teaserDue: false }),
    resendDelayMs: 50,
    notifier: { notify: () => {} }
  });
  return { journal, model };
}

describe('a server tool in the turn loop', () => {
  it('killed mid-call: interrupted with Run again, and never sent to the server again', async () => {
    const world = nodeWorld();
    const store = memorySettingsStore();
    const script = (r: ModelRequest): FakeReply => {
      const last = r.messages.at(-1);
      if (last?.role === 'tool') return { text: `Done. (${last.content.slice(0, 80)})` };
      return { text: 'On it.', toolCalls: [{ id: 'call-1', name: 'fakeserver__slow', arguments: { ms: 20_000 } }] };
    };
    const one = await life(world, store, undefined, script);
    void one.journal.send('Please wait a while.', 'turn-1');
    for (let i = 0; i < 500 && slowCalls(one.port) < 1; i++) await sleep(10);
    expect(slowCalls(one.port)).toBe(1);
    // The app dies: the journal is dropped with no shutdown, and the server's run ends with the job.
    one.journal.kill();
    await one.port.closeAll();

    const two = await life(world, store, one.serverId, script);
    const sent = await two.journal.send('Please wait a while.', 'turn-1');
    if (!sent.replied) throw new Error('not replied');
    const end = await two.journal.turn(sent.turn.id).wait();
    const questions = await two.journal.questions();
    expect(end.status).toBe('asks');
    expect(questions).toHaveLength(1);
    expect(questions[0]!.text).toMatch(/^fakeserver__slow was cut off/);
    expect(questions[0]!.kind).toBe('rerun');
    const transcript = JSON.stringify(await two.journal.transcript());
    expect(transcript).toMatch(/may have partially run/);
    // Never sent again, by either life's server.
    await sleep(200);
    expect(slowCalls(two.port)).toBe(0);
    await two.journal.close();
  });

  it('killed mid-call, then reopened with no server tools at all: still the Run again question, and nothing runs', async () => {
    const world = nodeWorld();
    const store = memorySettingsStore();
    const script = (r: ModelRequest): FakeReply => {
      const last = r.messages.at(-1);
      if (last?.role === 'tool') return { text: `Done. (${last.content.slice(0, 80)})` };
      return { text: 'On it.', toolCalls: [{ id: 'call-1', name: 'fakeserver__slow', arguments: { ms: 20_000 } }] };
    };
    const one = await life(world, store, undefined, script);
    void one.journal.send('Please wait a while.', 'turn-1');
    for (let i = 0; i < 500 && slowCalls(one.port) < 1; i++) await sleep(10);
    expect(slowCalls(one.port)).toBe(1);
    one.journal.kill();
    await one.port.closeAll();
    // The server isn't started this time: the turn loop holds no wrapper for the cut-off call.
    const two = await turnLoop(world, [], script);
    const sent = await two.journal.send('Please wait a while.', 'turn-1');
    if (!sent.replied) throw new Error('not replied');
    const end = await two.journal.turn(sent.turn.id).wait();
    expect(end.status).toBe('asks');
    const questions = await two.journal.questions();
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ kind: 'rerun', tool: 'fakeserver__slow' });
    expect(questions[0]!.text).toMatch(/^fakeserver__slow was cut off/);
    await two.journal.close();
  });

  /** A chat whose model calls the fake server's echo on every turn, with the gate's policy read from the
      wrappers the turn loop holds and the client's saved choices. */
  async function echoChat(storeName: string, answer: boolean) {
    const world = nodeWorld();
    const store = memorySettingsStore();
    const cards: ConsentCard[] = [];
    const script = (r: ModelRequest): FakeReply => (r.messages.at(-1)?.role === 'tool' ? { text: 'Done.' } : { text: 'On it.', toolCalls: [{ id: `call-${r.messages.length}`, name: 'fakeserver__echo', arguments: { text: 'hi' } }] });
    let held: ServerTool[] = [];
    let client!: McpClient;
    const policy = () => client.policy(held);
    const one = await life(world, store, undefined, script, { policy, ask: (card) => { cards.push(card); return answer; }, storeName, review: true });
    held = one.tools;
    client = one.client;
    const echo = held.find(t => t.serverName === 'echo')!;
    const calls = () => one.port.written.filter(l => l.includes('"tools/call"') && l.includes('"name":"echo"')).length;
    let n = 0;
    const turn = async () => {
      const t = await one.journal.send(`Echo something ${++n}.`, `turn-${n}`);
      if (!t.replied) throw new Error('not replied');
      await one.journal.turn(t.turn.id).wait();
    };
    return { one, client, echo, cards, calls, turn };
  }

  it('G12: no server tool runs without your Yes to that call; an "always" is refused when saved, and a policy saying allow still asks', async () => {
    for (const mutation of [undefined, 'server-always'] as const) {
      mutations.set(mutation ? [mutation] : []);
      try {
        const c = await echoChat(`mcp-g12-${mutation ?? 'twin'}`, false);
        const saved = await c.client.choose(c.echo.server.id, 'echo', { policy: 'allow', fingerprint: c.echo.fingerprint, setupFingerprint: c.echo.setupFingerprint }).then(() => 'saved', (e: Error) => e.message);
        await c.turn();
        if (mutation === undefined) {
          expect(saved).toMatch(/no "always" for a server's tool/);
          // The card is shown, the person says no, and nothing reaches the server.
          expect(c.cards.map((x) => x.tool)).toEqual(['fakeserver__echo']);
          expect(c.calls()).toBe(0);
        } else {
          // The control: the old "always" back, and the call goes out with no Yes to it.
          expect(c.cards).toEqual([]);
          expect(c.calls()).toBe(1);
        }
        await c.one.journal.close();
      } finally {
        mutations.clear();
      }
    }
  });

  it('"may run on its own": that one tool runs unasked for exactly its version and setup; a changed fingerprint clears it, and a revoke takes it back', async () => {
    for (const mutation of [undefined, 'own-ignores-fingerprint'] as const) {
      mutations.set(mutation ? [mutation] : []);
      try {
        const c = await echoChat(`mcp-own-${mutation ?? 'twin'}`, true);
        // The first call asks; its card offers "May run on its own", in words that say what it lets her do.
        await c.turn();
        expect(c.cards).toHaveLength(1);
        expect(c.cards[0]!.own).toMatch(/whenever she decides to, without asking you, even when something a server said led her there/);
        expect(buttonsOf(c.cards[0]!)).toEqual(['yes', 'own', 'skip']);
        // The grant, for the card's own facts.
        await c.client.choose(c.echo.server.id, 'echo', { policy: 'own', fingerprint: c.cards[0]!.facts!.fingerprint, setupFingerprint: c.cards[0]!.facts!.launch });
        await c.turn();
        expect(c.cards).toHaveLength(1);
        expect(c.calls()).toBe(2);
        // The server changes echo: the grant is cleared with the catalog write, and the changed tool asks.
        await callWithYes(c.client, c.one.serverId, 'set_variant', { variant: 'b' });
        for (let i = 0; i < 300 && c.client.tools().find(t => t.serverName === 'echo')!.fingerprint === c.echo.fingerprint; i++) await sleep(10);
        for (let i = 0; i < 300 && !mutation && c.client.choices()[choiceKey(c.echo.server.id, 'echo')]; i++) await sleep(10);
        await c.turn();
        if (mutation === undefined) {
          expect(c.client.choices()[choiceKey(c.echo.server.id, 'echo')]).toBeUndefined();
          expect(c.cards).toHaveLength(2);
          expect(c.cards[1]!.facts!.fingerprint).not.toBe(c.echo.fingerprint);
        } else {
          // The control: the grant kept for a tool that changed, and it ran unasked.
          expect(c.cards).toHaveLength(1);
        }
        expect(c.calls()).toBe(3);
        await c.one.journal.close();
      } finally {
        mutations.clear();
      }
    }
  });

  it('"may run on its own" revoked: the next call asks at once', async () => {
    const c = await echoChat('mcp-own-revoke', true);
    await c.client.choose(c.echo.server.id, 'echo', { policy: 'own', fingerprint: c.echo.fingerprint, setupFingerprint: c.echo.setupFingerprint });
    await c.turn();
    expect(c.cards).toEqual([]);
    expect(c.calls()).toBe(1);
    expect((await c.client.revoke(c.echo.server.id, 'echo', 'ask')).ok).toBe(true);
    await c.turn();
    expect(c.cards).toHaveLength(1);
    expect(c.calls()).toBe(2);
    await c.one.journal.close();
  });

  it("r20 #1: a turn's saved wrapper from z is never run on a's \"may run on its own\", whatever names the servers have now", async () => {
    const world = nodeWorld();
    const port = nodeProcessPort();
    cleanups.push(() => port.closeAll());
    const client = await McpClient.open({ paths: testPaths, store: memorySettingsStore(), processes: port, net: nodeNetPort(), addresses: { add: async () => ({ id: 'x' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: systemClock });
    const add = async (id: string) => {
      const { drafts } = parsePaste(JSON.stringify({ mcpServers: { Same: { command: process.execPath, args: [FAKE_MAIN] } } }), { newId: () => id, defaultCwd: REPO, paths: testPaths });
      await client.add(drafts[0]!);
    };
    await add('z');
    await add('a');
    expect((await client.start('z')).kind).toBe('ready');
    // A turn loop holds z's wrappers, from when z ran alone.
    const held = client.tools();
    expect(held.find(t => t.serverName === 'echo')!.name).toBe('same__echo');
    expect((await client.start('a')).kind).toBe('ready');
    const aEcho = client.tools().find(t => t.server.id === 'a' && t.serverName === 'echo')!;
    // "May run on its own" only for a's echo.
    const choices: Record<string, ToolChoice> = { [choiceKey('a', 'echo')]: { policy: 'own', fingerprint: aEcho.fingerprint, setupFingerprint: aEcho.setupFingerprint } };
    // Frozen keys: z keeps its name, and a has its own.
    expect(client.tools().map(t => t.name).sort()).toEqual(expect.arrayContaining(['same__echo', 'same2__echo']));
    let asks = 0;
    const script = (r: ModelRequest): FakeReply => (r.messages.at(-1)?.role === 'tool' ? { text: 'Done.' } : { text: 'On it.', toolCalls: [{ id: 'call-1', name: 'same__echo', arguments: { text: 'hi' } }] });
    const loop = await turnLoop(world, held, script, { policy: () => ({ perTool: toolPolicies(held, choices) }), ask: () => { asks++; return false; }, storeName: 'mcp-r20-1' });
    const t = await loop.journal.send('Echo something.', 'turn-1');
    if (!t.replied) throw new Error('not replied');
    await loop.journal.turn(t.turn.id).wait();
    // z's wrapper went to the gate as z's: it asked, the person said no, and nothing was sent.
    expect(asks).toBe(1);
    expect(port.written.filter(l => l.includes('"tools/call"') && l.includes('"name":"echo"'))).toEqual([]);
    await loop.journal.close();
  });

  it('T7 (i), S9: a duplicated Yes from the first card, arriving after the changed tool\'s card is shown, answers nothing', async () => {
    for (const mutation of [undefined, 'answers-by-step'] as const) {
      mutations.set(mutation ? [mutation] : []);
      try {
        const world = nodeWorld();
        const store = memorySettingsStore();
        const desk = createCardDesk();
        const echoCalls = (port: NodeProcessPort) => port.written.filter(l => l.includes('"tools/call"') && l.includes('"name":"echo"')).length;
        const script = (r: ModelRequest): FakeReply => (r.messages.at(-1)?.role === 'tool' ? { text: 'Done.' } : { text: 'On it.', toolCalls: [{ id: 'call-1', name: 'fakeserver__echo', arguments: { text: 'hi' } }] });
        const one = await life(world, store, undefined, script, { consent: desk.port, storeName: `mcp-s9-${mutation ?? 'twin'}` });
        void one.journal.send('Echo something.', 'turn-1');
        const shown = async (n: number) => { for (let i = 0; i < 500 && desk.showing().length < n; i++) await sleep(10); return desk.showing(); };
        const f1 = (await shown(1))[0]!.card;
        // The server changes echo while F1's card is shown.
        await callWithYes(one.client, one.serverId, 'set_variant', { variant: 'b' });
        for (let i = 0; i < 200 && one.client.tools().find(t => t.serverName === 'echo')!.fingerprint === f1.facts!.fingerprint; i++) await sleep(10);
        // The Yes to F1: the facts changed, so it sends nothing and F2's card is shown.
        expect(desk.answer({ presentation: f1.presentation, button: 'yes' })).toMatchObject({ kind: 'answered', yes: true });
        for (let i = 0; i < 500 && !desk.showing().some((s) => s.card.presentation !== f1.presentation); i++) await sleep(10);
        const f2 = desk.showing()[0]!.card;
        expect(f2.presentation).not.toBe(f1.presentation);
        expect(f2.facts!.fingerprint).not.toBe(f1.facts!.fingerprint);
        // The duplicated Yes from F1's card, as a double click or a resend would bring it.
        const dup = desk.answer({ presentation: f1.presentation, button: 'yes' });
        await sleep(200);
        if (mutation === undefined) {
          expect(dup).toEqual({ kind: 'ignored' });
          expect(desk.showing().map((s) => s.card.presentation)).toEqual([f2.presentation]);
          expect(echoCalls(one.port)).toBe(0);
          desk.answer({ presentation: f2.presentation, button: 'skip' });
        } else {
          // The control: answers keyed by the card's step let F1's Yes answer F2's card, and echo goes out.
          expect(echoCalls(one.port)).toBe(1);
        }
        await one.journal.close();
      } finally {
        mutations.clear();
      }
    }
  });
});
