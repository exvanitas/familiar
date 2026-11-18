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
import type { ConsentCard } from '../../src/index.ts';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const slowCalls = (port: NodeProcessPort) => port.written.filter(l => l.includes('"tools/call"') && l.includes('"name":"slow"')).length;

async function life(world: NodeWorld, store: SettingsStore, id: string | undefined, script: (r: ModelRequest) => FakeReply, extra: { policy?: () => GatePolicy; ask?: (card: ConsentCard) => boolean | void; storeName?: string; choices?: () => Record<string, ToolChoice> } = {}) {
  const port = nodeProcessPort();
  cleanups.push(() => port.closeAll());
  const client = await McpClient.open({ paths: testPaths, store, processes: port, net: nodeNetPort(), addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: systemClock, ...(extra.choices ? { choices: extra.choices } : {}) });
  let serverId = id;
  if (!serverId) {
    const { drafts } = parsePaste(JSON.stringify({ mcpServers: { 'Fake server': { command: process.execPath, args: [FAKE_MAIN] } } }), { newId: () => 'fake-journal', defaultCwd: REPO, paths: testPaths });
    serverId = (await client.add(drafts[0]!)).id;
  }
  expect((await client.start(serverId)).kind).toBe('ready');
  const tools = client.tools();
  const { journal, model } = await turnLoop(world, tools, script, extra);
  return { port, client, journal, model, serverId, tools };
}

/** A journal over the given wrappers: the tools a turn loop holds until it's opened again. */
async function turnLoop(world: NodeWorld, tools: ServerTool[], script: (r: ModelRequest) => FakeReply, extra: { policy?: () => GatePolicy; ask?: (card: ConsentCard) => boolean | void; storeName?: string } = {}) {
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
    consent: { ask: (card) => Promise.resolve(extra.ask?.(card) ?? true) },
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
      return { text: 'On it.', toolCalls: [{ id: 'call-1', name: 'Fake_server__slow', arguments: { ms: 20_000 } }] };
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
    expect(questions[0]!.text).toMatch(/^Fake_server__slow was cut off/);
    expect(questions[0]!.kind).toBe('rerun');
    const transcript = JSON.stringify(await two.journal.transcript());
    expect(transcript).toMatch(/may have partially run/);
    // Never sent again, by either life's server.
    await sleep(200);
    expect(slowCalls(two.port)).toBe(0);
    await two.journal.close();
  });

  it('"always" runs a call only while the conversation holds no outside content; after a server result, and a changed tool, it asks, with the facts read now (G12, r19 #15)', async () => {
    const world = nodeWorld();
    const store = memorySettingsStore();
    const cards: ConsentCard[] = [];
    let choices: Record<string, ToolChoice> = {};
    const echoCalls = (port: NodeProcessPort) => port.written.filter(l => l.includes('"tools/call"') && l.includes('"name":"echo"')).length;
    const script = (r: ModelRequest): FakeReply => {
      const last = r.messages.at(-1);
      if (last?.role === 'tool') return { text: 'Done.' };
      return { text: 'On it.', toolCalls: [{ id: `call-${r.messages.length}`, name: 'Fake_server__echo', arguments: { text: 'hi' } }] };
    };
    // The gate's policy comes from the wrappers the turn loop holds, each by its own identity.
    let held: ServerTool[] = [];
    const policy = () => ({ perTool: toolPolicies(held, choices) });
    const one = await life(world, store, undefined, script, { policy, ask: (card) => { cards.push(card); }, storeName: 'mcp-consent', choices: () => choices });
    held = one.tools;
    const client: McpClient = one.client;
    const echo = client.tools().find(t => t.serverName === 'echo')!;
    choices = { [choiceKey(echo.server.id, 'echo')]: { policy: 'allow', fingerprint: echo.fingerprint, setupFingerprint: echo.setupFingerprint } };

    // "Always", and nothing outside in the conversation yet: it runs without asking.
    const t1 = await one.journal.send('Echo something.', 'turn-1');
    if (!t1.replied) throw new Error('not replied');
    await one.journal.turn(t1.turn.id).wait();
    expect(cards).toEqual([]);
    expect(echoCalls(one.port)).toBe(1);

    // The server changes echo while it runs.
    await callWithYes(client, one.serverId, 'set_variant', { variant: 'b' });
    for (let i = 0; i < 200 && client.tools().find(t => t.serverName === 'echo')!.fingerprint === echo.fingerprint; i++) await sleep(10);
    const changed = client.tools().find(t => t.serverName === 'echo')!;

    // The conversation now holds the server's result: "always" doesn't apply, the card offers no Always,
    // and it shows the tool as the server offers it now.
    const t2 = await one.journal.send('Echo something again.', 'turn-2');
    if (!t2.replied) throw new Error('not replied');
    await one.journal.turn(t2.turn.id).wait();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.always).toBe(false);
    expect(cards[0]!.facts).toMatchObject({ server: one.serverId, tool: 'echo', fingerprint: changed.fingerprint });
    expect(cards[0]!.presentation).toMatch(/^[0-9a-z]+$/);
    expect(echoCalls(one.port)).toBe(2);
    await one.journal.close();
  });

  it("r20 #1: a turn's saved wrapper from z is never allowed by a's \"always\", whatever names the servers have now", async () => {
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
    expect(held.find(t => t.serverName === 'echo')!.name).toBe('Same__echo');
    expect((await client.start('a')).kind).toBe('ready');
    const aEcho = client.tools().find(t => t.server.id === 'a' && t.serverName === 'echo')!;
    // "Always" only for a's echo.
    const choices: Record<string, ToolChoice> = { [choiceKey('a', 'echo')]: { policy: 'allow', fingerprint: aEcho.fingerprint, setupFingerprint: aEcho.setupFingerprint } };
    // With both running, neither has the name z's wrapper carries.
    expect(client.tools().map(t => t.name)).not.toContain('Same__echo');
    let asks = 0;
    const script = (r: ModelRequest): FakeReply => (r.messages.at(-1)?.role === 'tool' ? { text: 'Done.' } : { text: 'On it.', toolCalls: [{ id: 'call-1', name: 'Same__echo', arguments: { text: 'hi' } }] });
    const loop = await turnLoop(world, held, script, { policy: () => ({ perTool: toolPolicies(held, choices) }), ask: () => { asks++; return false; }, storeName: 'mcp-r20-1' });
    const t = await loop.journal.send('Echo something.', 'turn-1');
    if (!t.replied) throw new Error('not replied');
    await loop.journal.turn(t.turn.id).wait();
    // z's wrapper went to the gate as z's: it asked, the person said no, and nothing was sent.
    expect(asks).toBe(1);
    expect(port.written.filter(l => l.includes('"tools/call"') && l.includes('"name":"echo"'))).toEqual([]);
    await loop.journal.close();
  });
});
