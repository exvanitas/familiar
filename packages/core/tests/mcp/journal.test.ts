// A real server tool in the turn loop, killed mid-call. Life 1: the model calls the fake server's slow
// tool, it's under way, and the app dies (the journal is abandoned and the server's run ends with it).
// Life 2: a new client starts the server again and the journal resumes. The call is reported as
// interrupted, with Run again, and the server never gets it a second time.
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeModel, type FakeReply } from '../../src/testing/index.ts';
import { choiceKey, decideByRules, McpClient, openJournal, parsePaste, posixPaths, systemClock, toolPolicies, type GatePolicy, type ModelRequest, type ToolChoice } from '../../src/index.ts';
import { memorySettingsStore, type SettingsStore } from '../../src/settings/store.ts';
import { nodeWorld, type NodeWorld } from '../journal/node-env.ts';
import { FAKE_MAIN, REPO } from './fake.ts';
import { nodeProcessPort, type NodeProcessPort } from './node-process.ts';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const slowCalls = (port: NodeProcessPort) => port.written.filter(l => l.includes('"tools/call"') && l.includes('"name":"slow"')).length;

async function life(world: NodeWorld, store: SettingsStore, id: string | undefined, script: (r: ModelRequest) => FakeReply, extra: { policy?: () => GatePolicy; ask?: () => void; storeName?: string } = {}) {
  const port = nodeProcessPort();
  cleanups.push(() => port.closeAll());
  const client = await McpClient.open({ paths: posixPaths, store, processes: port, fetchFor: () => fetch, addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: systemClock });
  let serverId = id;
  if (!serverId) {
    const { drafts } = parsePaste(JSON.stringify({ mcpServers: { 'Fake server': { command: process.execPath, args: [FAKE_MAIN] } } }), { newId: () => 'fake-journal', defaultCwd: REPO, paths: posixPaths });
    serverId = (await client.add(drafts[0]!)).id;
  }
  expect((await client.start(serverId)).kind).toBe('ready');
  const model = createFakeModel(script);
  const journal = await openJournal({
    store: await world.open(extra.storeName ?? 'mcp-kill'),
    owner: world.owner,
    model,
    modelId: 'fake-1',
    caps: { config: { maxReplyTokens: 200 }, call: { persona: 'olive', price: { inputPerMTok: 1, outputPerMTok: 2 } } },
    tools: client.tools(),
    clock: systemClock,
    wake: { wakeAt: () => {} },
    consent: { ask: () => { extra.ask?.(); return Promise.resolve(true); } },
    ...(extra.policy ? { policy: extra.policy } : {}),
    presence: { report: () => {} },
    persona: { id: 'olive', name: 'Olive', instructions: 'You are Olive.' },
    decider: { decide: async (event, context) => decideByRules(event, context) },
    ambient: () => ({ persona: { sketch: 'kind', interests: [] }, chattiness: 'medium', doNotDisturb: false, fullscreen: false, sentAway: false, chatInFront: true, teaserDue: false }),
    resendDelayMs: 50,
    notifier: { notify: () => {} }
  });
  return { port, client, journal, model, serverId };
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

  it('a tool changed on the running server: the gate asks again, and the old wrapper never sends (r19 #15)', async () => {
    const world = nodeWorld();
    const store = memorySettingsStore();
    let asks = 0;
    let choices: Record<string, ToolChoice> = {};
    const echoCalls = (port: NodeProcessPort) => port.written.filter(l => l.includes('"tools/call"') && l.includes('"name":"echo"')).length;
    const script = (r: ModelRequest): FakeReply => {
      const last = r.messages.at(-1);
      if (last?.role === 'tool') return { text: 'Done.' };
      return { text: 'On it.', toolCalls: [{ id: `call-${r.messages.length}`, name: 'Fake_server__echo', arguments: { text: 'hi' } }] };
    };
    let client!: McpClient;
    const policy = () => ({ perTool: toolPolicies(client.tools(), choices) });
    const one = await life(world, store, undefined, script, { policy, ask: () => asks++, storeName: 'mcp-consent' });
    client = one.client;
    const echo = client.tools().find(t => t.serverName === 'echo')!;
    choices = { [choiceKey(echo.server.id, 'echo')]: { policy: 'allow', fingerprint: echo.fingerprint, setupFingerprint: echo.setupFingerprint } };

    // "Always": it runs without asking.
    const t1 = await one.journal.send('Echo something.', 'turn-1');
    if (!t1.replied) throw new Error('not replied');
    await one.journal.turn(t1.turn.id).wait();
    expect(asks).toBe(0);
    expect(echoCalls(one.port)).toBe(1);

    // The server changes echo while it runs.
    await client.call(one.serverId, 'set_variant', { variant: 'b' });
    for (let i = 0; i < 200 && client.tools().find(t => t.serverName === 'echo')!.fingerprint === echo.fingerprint; i++) await sleep(10);

    // The same journal, with the old wrapper: the gate asks, and the call isn't sent.
    const t2 = await one.journal.send('Echo something again.', 'turn-2');
    if (!t2.replied) throw new Error('not replied');
    await one.journal.turn(t2.turn.id).wait();
    expect(asks).toBe(1);
    expect(echoCalls(one.port)).toBe(1);
    expect(JSON.stringify(await one.journal.transcript())).toMatch(/echo changed since it was offered, so Familiar didn't send the call/);
    await one.journal.close();
  });
});
