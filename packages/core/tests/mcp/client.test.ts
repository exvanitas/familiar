// The MCP client against the real fake server, over the Node process adapter (which blanks secrets as the
// exe does) and over HTTP: add, list, call through `send` with a decision, Stop, a deadline, a crash
// mid-call (Failed until Start, no automatic restart), a changed tool, a printed secret, and remove with a
// call in flight.
import { afterEach, describe, expect, it } from 'vitest';
import { startHttp } from '../../../../tools/fake-mcp-server/src/http.ts';
import { OUTSIDE_CONTENT } from '../../../../tools/fake-mcp-server/src/server.ts';
import { systemClock } from '../../src/journal/journal.ts';
import { choiceKey, KEY_PLACEHOLDER, sha256, localDraft, McpClient, parsePaste, remoteDraft, SSE_WORDS, toolPolicies, type McpClientOptions, type NetPort, type ServerTool, type ToolChoice } from '../../src/index.ts';
import { mintDecision } from '../../src/mcp/decision.ts';
import { callWithYes, runWithYes, yesFor } from '../../src/testing/index.ts';
import { nodeNetPort } from './node-net.ts';
import { memorySettingsStore } from '../../src/settings/store.ts';
import { FAKE_MAIN, BLANKED_VALUE, REPO, testPaths } from './fake.ts';
import { nodeProcessPort, type NodeProcessPort } from './node-process.ts';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

let ids = 0;
const newId = () => `srv-${++ids}`;

interface World {
  client: McpClient;
  port: NodeProcessPort;
  store: ReturnType<typeof memorySettingsStore>;
  deleted: string[];
  addresses: { added: string[]; removed: string[] };
  secrets: Map<string, string>;
}

async function world(extra: Partial<McpClientOptions> = {}): Promise<World> {
  const secrets = new Map<string, string>();
  const port = nodeProcessPort({ secret: (id, name) => secrets.get(`server:${id}:${name}`) });
  const store = memorySettingsStore();
  const deleted: string[] = [];
  const addresses = { added: [] as string[], removed: [] as string[] };
  const client = await McpClient.open({
    paths: testPaths,
    store,
    processes: port,
    net: nodeNetPort(),
    addresses: { add: async ({ url }) => { addresses.added.push(url); return { id: `addr-${addresses.added.length}` }; }, remove: async id => { addresses.removed.push(id); } },
    secrets: { delete: async ref => { deleted.push(ref); secrets.delete(ref); } },
    clock: systemClock,
    ...extra
  });
  cleanups.push(() => port.closeAll());
  return { client, port, store, deleted, addresses, secrets };
}

/** What a README gives, with the program made absolute so the test needs no PATH. */
const paste = (env: Record<string, string> = {}, args: string[] = []) => JSON.stringify({
  mcpServers: { 'Fake server': { command: process.execPath, args: [FAKE_MAIN, ...args], env } }
});

/** Adds the fake server by paste, as Settings would: the draft's secret values go to "Credential
    Manager", and core gets the draft. */
async function addFake(w: World, env: Record<string, string> = {}, args: string[] = []) {
  const { drafts } = parsePaste(paste(env, args), { newId, defaultCwd: REPO, paths: testPaths });
  const draft = drafts[0]!;
  expect(draft.problems).toEqual([]);
  const { id, secretRefs } = await w.client.add(draft);
  for (const [name, value] of draft.secrets) {
    const ref = `server:${id}:${name}`;
    expect(secretRefs).toContain(ref);
    w.secrets.set(ref, value);
  }
  return id;
}

const sentCalls = (port: NodeProcessPort, tool: string) => port.written.filter(l => l.includes('"tools/call"') && l.includes(`"name":"${tool}"`)).length;
const until = async (f: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 20));
  }
};

describe('the MCP client, local, against the fake server', () => {
  it('adds by paste with nothing secret saved, tests, lists, and calls', async () => {
    const w = await world();
    const id = await addFake(w, { FAKE_SECRET: BLANKED_VALUE, LOG_LEVEL: 'info' });
    // Saved: the secret's name, never its value. A short value is a plain setting.
    const saved = JSON.stringify((await w.store.get('mcp.owner'))?.value);
    expect(saved).not.toContain(BLANKED_VALUE);
    expect(saved).toContain('FAKE_SECRET');
    expect(saved).toContain('LOG_LEVEL');

    const report = await w.client.test(id);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.tools.map(t => t.name)).toContain('echo');
    expect(report.tools).toHaveLength(11);
    expect(report.tools.every(t => t.fresh && /^[0-9a-f]{64}$/.test(t.fingerprint))).toBe(true);
    // Test stops it again, since it wasn't running.
    expect(w.client.get(id)?.phase).toBe('stopped');
    expect(w.port.asked).toBe(1);

    await w.client.markReviewed(id, report.report, report.tools.map(t => t.name));
    expect((await w.client.start(id)).kind).toBe('ready');
    // Approved once: the second start asked nothing.
    expect(w.port.asked).toBe(1);
    const tools = w.client.tools();
    const echo = tools.find(t => t.serverName === 'echo')!;
    expect(echo.name).toBe('fakeserver__echo');
    expect(echo.kind).toBe('server');
    expect(echo.outside).toBe(true);
    expect(echo.fresh).toBe(false);
    expect(echo.readOnlyHint).toBe(true);
    expect(echo.doing({})).toBe('calling echo on Fake server');
    const text = await runWithYes(echo, { text: 'hello' });
    expect(text).toMatch(/^\[Outside content: what the MCP server "Fake server" returned from echo\./);
    expect(text.endsWith('\nhello')).toBe(true);
    const page = await callWithYes(w.client, id, 'read_page', {});
    expect(page).toEqual({ kind: 'result', text: OUTSIDE_CONTENT, isError: false });
    const failed = await callWithYes(w.client, id, 'fail', {});
    expect(failed).toMatchObject({ kind: 'result', isError: true });
    await expect(runWithYes(tools.find(t => t.serverName === 'fail')!, {})).rejects.toThrow(/failed on purpose/);
  });

  it('Stop answers at once and sends the cancellation; a deadline does the same', async () => {
    const w = await world();
    const id = await addFake(w);
    await w.client.start(id);
    const stop = new AbortController();
    const t0 = Date.now();
    const slow = callWithYes(w.client, id, 'slow', { ms: 20_000 }, stop.signal);
    await until(() => sentCalls(w.port, 'slow') === 1);
    stop.abort();
    expect(await slow).toEqual({ kind: 'stopped' });
    expect(Date.now() - t0).toBeLessThan(2000);
    await until(() => w.port.written.some(l => l.includes('notifications/cancelled')));

    await w.client.setLimits(id, { callMs: 1000 });
    // The stopped call's cancel write is the last of its exchange: the slot frees once it's written.
    await new Promise(r => setTimeout(r, 50));
    const t1 = Date.now();
    expect(await callWithYes(w.client, id, 'slow', { ms: 20_000 })).toEqual({ kind: 'timed-out' });
    expect(Date.now() - t1).toBeLessThan(2500);
    await w.client.setLimits(id, {});
    await until(() => w.port.written.filter(l => l.includes('notifications/cancelled')).length === 2);
    await new Promise(r => setTimeout(r, 50));
    // The server is still there for the next call.
    expect(await callWithYes(w.client, id, 'echo', { text: 'still here' })).toMatchObject({ kind: 'result', text: 'still here' });
  });

  it('a crash mid-call is answered interrupted and never sent again; the server waits, Failed, for Start', async () => {
    const w = await world();
    const id = await addFake(w);
    await w.client.start(id);
    const before = w.port.pids();
    const outcome = await callWithYes(w.client, id, 'crash', {});
    expect(outcome).toEqual({ kind: 'interrupted' });
    await until(() => w.client.get(id)?.phase === 'failed');
    expect(w.client.get(id)?.failure).toMatchObject({ kind: 'exited', lastOutput: expect.stringContaining('crashing on purpose') });
    expect(w.client.tools()).toEqual([]);
    expect(await callWithYes(w.client, id, 'echo', { text: 'x' })).toMatchObject({ kind: 'error', reason: 'not-running' });
    expect((await w.client.start(id)).kind).toBe('ready');
    expect(w.port.pids()).not.toEqual(before);
    expect(await callWithYes(w.client, id, 'echo', { text: 'after' })).toMatchObject({ kind: 'result', text: 'after' });
    // Sent once, on the run that crashed, and never again.
    expect(sentCalls(w.port, 'crash')).toBe(1);
    // The model's view of it.
    const crash = w.client.tools().find(t => t.serverName === 'crash')!;
    await expect(runWithYes(crash, {})).rejects.toThrow(/may have partly run\. Familiar did not send it again/);
  });

  it('a new version puts every tool back to ask; an edit needs the server stopped', async () => {
    const w = await world();
    const id = await addFake(w);
    const first = await w.client.test(id);
    if (!first.ok) throw new Error(first.failure.words);
    await w.client.markReviewed(id, first.report, first.tools.map(t => t.name));
    await w.client.start(id);
    const a = w.client.tools();
    // The person let every tool run on its own, for this exact tool and setup, keyed by server and tool.
    const always = Object.fromEntries(a.map(t => [choiceKey(t.server.id, t.serverName), { policy: 'own' as const, fingerprint: t.fingerprint, setupFingerprint: t.setupFingerprint }]));
    expect(Object.values(toolPolicies(a, always)).every(p => p === 'own')).toBe(true);
    expect(Object.keys(toolPolicies(a, always))).toHaveLength(a.length);
    await w.client.stop(id);

    // The same server, now variant b, edited while stopped, then started: the run is the new setup.
    const { drafts } = parsePaste(paste({}, ['--variant', 'b']), { newId, defaultCwd: REPO, paths: testPaths });
    await w.client.edit(id, drafts[0]!);
    expect((await w.client.start(id)).kind).toBe('ready');
    expect(w.port.written.some(l => l.includes('initialize'))).toBe(true);
    expect(await callWithYes(w.client, id, 'echo', { text: 'new' })).toMatchObject({ kind: 'result', text: 'NEW' });
    const b = w.client.tools();
    expect(b.every(t => t.setupFingerprint !== a[0]!.setupFingerprint)).toBe(true);
    expect(b.filter(t => t.fresh).map(t => t.serverName)).toEqual(['echo']);
    // A new setup: "may run on its own" no longer holds for any tool. "Never" still holds.
    expect(toolPolicies(b, always)).toEqual({});
    const echo = b.find(t => t.serverName === 'echo')!;
    expect(toolPolicies(b, { [choiceKey(id, 'echo')]: { policy: 'deny', fingerprint: 'old', setupFingerprint: 'old' } })).toEqual({ [echo.name]: 'deny' });
    // The exe asked again, since the arguments changed.
    expect(w.port.asked).toBe(2);
    // An edit is refused while the server runs.
    await expect(w.client.edit(id, drafts[0]!)).rejects.toThrow('Stop the server before changing it.');
  });

  it('a tool changed on the running server: a Yes given before the change never sends, and only that tool goes back to ask', async () => {
    const w = await world();
    const id = await addFake(w);
    await w.client.start(id);
    const before = w.client.tools();
    const always = Object.fromEntries(before.map(t => [choiceKey(t.server.id, t.serverName), { policy: 'own' as const, fingerprint: t.fingerprint, setupFingerprint: t.setupFingerprint }]));
    const oldEcho = before.find(t => t.serverName === 'echo')!;
    const oldYes = yesFor(w.client, id, 'echo', { text: 'old' })!;
    // The server changes echo while it runs, and says its tools changed.
    expect(await callWithYes(w.client, id, 'set_variant', { variant: 'b' })).toMatchObject({ kind: 'result' });
    await until(() => w.client.tools().find(t => t.serverName === 'echo')!.fingerprint !== oldEcho.fingerprint);
    const sentBefore = sentCalls(w.port, 'echo');
    expect(await w.client.send(oldYes, new AbortController().signal)).toMatchObject({ kind: 'error', words: expect.stringMatching(/tool changed since it was allowed/) });
    expect(sentCalls(w.port, 'echo')).toBe(sentBefore);
    const after = w.client.tools();
    const policies = toolPolicies(after, always);
    expect(policies[oldEcho.name]).toBeUndefined();
    expect(Object.keys(policies)).toHaveLength(after.length - 1);
    const newEcho = after.find(t => t.serverName === 'echo')!;
    expect(await runWithYes(newEcho, { text: 'new' })).toMatch(/\nNEW$/);
  });

  it('"may run on its own" never passes from one server to another with the same setup (r19 #4)', async () => {
    const w = await world();
    const a = await addFake(w);
    await w.client.start(a);
    const tool = w.client.tools().find(t => t.serverName === 'echo')!;
    const always = { [choiceKey(tool.server.id, 'echo')]: { policy: 'own' as const, fingerprint: tool.fingerprint, setupFingerprint: tool.setupFingerprint } };
    // The control: the choice does allow A's own tool.
    expect(toolPolicies([tool], always)).toEqual({ [tool.name]: 'own' });
    await w.client.stop(a);
    const b = await addFake(w);
    await w.client.start(b);
    const other = w.client.tools().find(t => t.serverName === 'echo')!;
    // A second server with the same label gets its own frozen key: the model's name differs too.
    expect(other.name).toBe('fakeserver2__echo');
    expect(tool.name).toBe('fakeserver__echo');
    expect(other.fingerprint).toBe(tool.fingerprint);
    expect(toolPolicies([other], always)).toEqual({});
  });

  it('a "never" for the wrapper\'s own identity refuses its call before sending, even past the gate', async () => {
    const w = await world();
    const id = await addFake(w);
    await w.client.start(id);
    const echo = w.client.tools().find(t => t.serverName === 'echo')!;
    await w.client.choose(id, 'echo', { policy: 'deny', fingerprint: echo.fingerprint, setupFingerprint: echo.setupFingerprint });
    await expect(runWithYes(echo, { text: 'no' })).rejects.toThrow(/You chose never to run echo/);
    expect(sentCalls(w.port, 'echo')).toBe(0);
    await w.client.choose(id, 'echo', undefined);
    expect(await runWithYes(echo, { text: 'yes' })).toMatch(/\nyes$/);
    // A revoke holds at once, in memory, whatever is saved.
    w.client.revoke(id, 'echo', 'never');
    await expect(runWithYes(echo, { text: 'no' })).rejects.toThrow(/You chose never to run echo/);
    expect(sentCalls(w.port, 'echo')).toBe(1);
  });

  it('a decision minted on "may run on its own" is checked again at the send: the grant changed or revoked, and nothing is written; "always" is refused at save', async () => {
    const w = await world();
    const id = await addFake(w);
    await w.client.start(id);
    const echo = w.client.tools().find(t => t.serverName === 'echo')!;
    const always: ToolChoice = { policy: 'own' as const, fingerprint: echo.fingerprint, setupFingerprint: echo.setupFingerprint };
    await expect(w.client.choose(id, 'echo', { ...always, policy: 'allow' })).rejects.toThrow(/no "always" for a server's tool/);
    const facts = w.client.facts(id, 'echo', { text: 'kept' })!;
    const signal = new AbortController().signal;
    await w.client.choose(id, 'echo', always);
    // Kept: it goes.
    expect(await w.client.send(mintDecision(facts, 's1', 'own'), signal)).toMatchObject({ kind: 'result', text: 'kept' });
    // The choice taken back after the mint: refused at the send.
    const d = mintDecision(facts, 's3', 'own');
    await w.client.choose(id, 'echo', undefined);
    expect(await w.client.send(d, signal)).toMatchObject({ kind: 'error', words: expect.stringMatching(/Your "may run on its own" for echo on this server no longer stands/) });
    // Withdrawn by the overlay: the same.
    await w.client.choose(id, 'echo', always);
    w.client.revoke(id, 'echo', 'ask');
    expect(await w.client.send(mintDecision(facts, 's4', 'own'), signal)).toMatchObject({ kind: 'error' });
    expect(sentCalls(w.port, 'echo')).toBe(1);
    // A Yes to this call needs only the tool unchanged and no "never".
    expect(await w.client.send(mintDecision(facts, 's5', 'asked'), signal)).toMatchObject({ kind: 'result' });
    // A decision is used once; a copy or a cast object is never genuine.
    const once = mintDecision(facts, 's6', 'asked');
    expect(await w.client.send(once, signal)).toMatchObject({ kind: 'result' });
    expect(await w.client.send(once, signal)).toMatchObject({ kind: 'error', words: expect.stringMatching(/used already/) });
    expect(await w.client.send({ ...once } as typeof once, signal)).toMatchObject({ kind: 'error' });
    expect(sentCalls(w.port, 'echo')).toBe(3);
  });

  it('a call already stopped is answered at once and writes nothing (r19 #13)', async () => {
    const w = await world();
    const id = await addFake(w);
    await w.client.start(id);
    const before = w.port.written.length;
    const stop = new AbortController();
    stop.abort();
    expect(await callWithYes(w.client, id, 'add_note', { text: 'never' }, stop.signal)).toEqual({ kind: 'stopped' });
    await new Promise(r => setTimeout(r, 100));
    expect(w.port.written.length).toBe(before);
  });

  it("print_secret comes back blanked: the reply, the model's text and the last output", async () => {
    const w = await world();
    const id = await addFake(w, { FAKE_SECRET: BLANKED_VALUE });
    await w.client.start(id);
    const r = await callWithYes(w.client, id, 'print_secret', {});
    expect(r).toEqual({ kind: 'result', text: 'The secret is [hidden].', isError: false });
    const text = await runWithYes(w.client.tools().find(t => t.serverName === 'print_secret')!, {});
    expect(text).not.toContain(BLANKED_VALUE);
    await callWithYes(w.client, id, 'crash', {});
    await until(() => w.client.get(id)?.phase === 'failed');
    const statuses = JSON.stringify(w.client.list());
    expect(statuses).not.toContain(BLANKED_VALUE);
  });

  it('remove with a call in flight: the call is interrupted, and the approval, secrets and record go', async () => {
    const w = await world();
    const id = await addFake(w, { FAKE_SECRET: BLANKED_VALUE });
    await w.client.start(id);
    const slow = callWithYes(w.client, id, 'slow', { ms: 20_000 });
    await until(() => sentCalls(w.port, 'slow') === 1);
    const removed = await w.client.remove(id);
    expect(removed).toEqual({ kind: 'removed' });
    expect(await slow).toEqual({ kind: 'interrupted' });
    expect(w.deleted).toEqual([`server:${id}:FAKE_SECRET`]);
    expect(w.client.owner.server(id)).toBeUndefined();
    expect(w.client.owner.tombstones()[id]).toEqual({ key: 'fakeserver' });
    expect(w.client.list()).toEqual([]);
    expect(w.port.pids()).toEqual([]);
    expect(await callWithYes(w.client, id, 'echo', { text: 'x' })).toMatchObject({ kind: 'error', reason: 'not-running' });
    // The approval went with it: the same setup asks again.
    const again = await addFake(w);
    await w.client.start(again);
    expect(w.port.asked).toBe(2);
  });

  it('a refused start and a missing program come back in plain words, and nothing retries', async () => {
    const no = await world();
    const port = nodeProcessPort({ ask: () => false });
    cleanups.push(() => port.closeAll());
    const client = await McpClient.open({ paths: testPaths, store: memorySettingsStore(), processes: port, net: nodeNetPort(), addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: systemClock });
    const { drafts } = parsePaste(paste(), { newId, defaultCwd: REPO, paths: testPaths });
    const { id } = await client.add(drafts[0]!);
    const r = await client.test(id);
    expect(r).toEqual({ ok: false, failure: { kind: 'declined', words: 'You chose not to start it.' } });
    expect(client.get(id)?.phase).toBe('stopped');
    expect(port.asked).toBe(1);

    const missing = localDraft({ label: 'Missing', command: 'npx', args: ['-y', 'familiar-no-such-package'], settings: [] }, { newId, defaultCwd: REPO, paths: testPaths });
    const { id: m } = await no.client.add({ ...missing, setup: { ...missing.setup, kind: 'local', program: 'familiar-no-such-npx' } as typeof missing.setup });
    const r2 = await no.client.test(m);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.failure.words).toContain("Familiar couldn't find the program");

    // A program that exits at once: its last output.
    const quick = localDraft({ label: 'Quick', command: process.execPath, args: ['-e', "console.error('no config file'); process.exit(2)"], settings: [] }, { newId, defaultCwd: REPO, paths: testPaths });
    const { id: q } = await no.client.add(quick);
    const r3 = await no.client.test(q);
    expect(r3).toMatchObject({ ok: false, failure: { kind: 'exited', words: 'The server exited with code 2. Its last output is below.', lastOutput: 'no config file' } });
  });

  it('the handshake deadline: a program that never speaks MCP', async () => {
    const w = await world({ limits: { startMs: 300 } });
    const silent = localDraft({ label: 'Silent', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], settings: [] }, { newId, defaultCwd: REPO, paths: testPaths });
    const { id } = await w.client.add(silent);
    const r = await w.client.test(id);
    expect(r).toMatchObject({ ok: false, failure: { kind: 'timed-out' } });
    await until(() => w.port.pids().length === 0);
  });

  it('starting with the app starts only the enabled servers', async () => {
    const w = await world();
    const on = await addFake(w);
    const off = await addFake(w);
    await w.client.setEnabled(on, true);
    // A fresh client over the same store, as at the next start of the app.
    const again = await McpClient.open({ paths: testPaths, store: w.store, processes: w.port, net: nodeNetPort(), addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: systemClock });
    again.startEnabled();
    await until(() => again.get(on)?.phase === 'ready');
    expect(again.get(off)?.phase).toBe('stopped');
    expect(again.tools().every(t => t.server.id === on)).toBe(true);
    await again.stop(on);
  });
});

describe('the MCP client, remote, against the fake server over HTTP', () => {
  it('adds the address, sends only the placeholder, lists and calls', async () => {
    const http = await startHttp();
    cleanups.push(() => http.close());
    const net = nodeNetPort();
    const w = await world({ net });
    const { drafts } = parsePaste(JSON.stringify({ mcpServers: { remote: { type: 'http', url: http.url, headers: { Authorization: 'Bearer remote-k1', 'X-Client': 'familiar-test' } } } }), { newId });
    const draft = drafts[0]!;
    expect(draft.problems).toEqual([]);
    expect(draft.key).toBe('remote-k1');
    const { id, secretRefs } = await w.client.add(draft);
    expect(w.addresses.added).toEqual([http.url]);
    expect(secretRefs).toEqual(['addr:addr-1']);
    expect(JSON.stringify((await w.store.get('mcp.owner'))?.value)).not.toContain('remote-k1');

    expect((await w.client.start(id)).kind).toBe('ready');
    expect(await callWithYes(w.client, id, 'echo', { text: 'over http' })).toMatchObject({ kind: 'result', text: 'over http' });
    expect(net.specs.length).toBeGreaterThan(0);
    for (const spec of net.specs) {
      const h = new Headers(spec.headers.map(([k, v]) => [k, v] as [string, string]));
      expect(h.get('authorization')).toBe(`Bearer ${KEY_PLACEHOLDER}`);
      expect(h.get('x-client')).toBe('familiar-test');
      expect(spec.address).toBe('addr-1');
    }
    // Every request it opened was ended through net_cancel.
    expect(new Set(net.cancels)).toEqual(new Set(net.specs.map(x => x.id)));
    expect((await w.client.remove(id)).kind).toBe('removed');
    expect(w.addresses.removed).toEqual(['addr-1']);
  });

  it('a refused key and an unreachable address come back in plain words', async () => {
    const refusing: NetPort = { fetch: async () => ({ status: 401, statusText: '', headers: [], url: '', redirected: false }), read: async () => new Uint8Array(0), cancel: async () => {} };
    const w = await world({ net: refusing });
    const { id } = await w.client.add(remoteDraft({ label: 'Refusing', url: 'https://mcp.example.test/mcp', headers: [['Authorization', 'Bearer some-key1']] }, { newId }));
    const r = await w.client.test(id);
    expect(r).toMatchObject({ ok: false, failure: { kind: 'http' } });
    if (!r.ok) expect(r.failure.words).toContain('HTTP 401');

    const failing: NetPort = { fetch: async () => { throw Object.assign(new Error('no key'), { kind: 'no-key' }); }, read: async () => new Uint8Array(0), cancel: async () => {} };
    const w2 = await world({ net: failing });
    const { id: id2 } = await w2.client.add(remoteDraft({ label: 'No key', url: 'https://mcp.example.test/mcp', headers: [] }, { newId }));
    const r2 = await w2.client.test(id2);
    expect(r2).toMatchObject({ ok: false, failure: { words: "This server's key isn't saved. Type it in Settings." } });
  });
});

describe('the tools a turn sees', () => {
  it('only Ready servers, each tool once, named for the model', async () => {
    const w = await world();
    const a = await addFake(w);
    const b = await addFake(w);
    await w.client.start(a);
    await w.client.start(b);
    const tools: ServerTool[] = w.client.tools();
    const names = tools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every(n => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(n))).toBe(true);
    // Two servers with the same label: each has its own frozen key, issued at add time.
    expect(names).toContain('fakeserver__echo');
    expect(names).toContain('fakeserver2__echo');
    await w.client.stop(b);
    expect(w.client.tools().every(t => t.server.id === a)).toBe(true);
  });
});

describe('the MCP client, remote: what it refuses (r19 #12)', () => {
  it('legacy SSE, in plain words, and a second server on an address already in use', async () => {
    const w = await world();
    const sse = remoteDraft({ label: 'Old style', url: 'https://mcp.example.test/sse', transport: 'sse', headers: [] }, { newId });
    expect(sse.problems).toContain(SSE_WORDS);
    await expect(w.client.add(sse)).rejects.toThrow(SSE_WORDS);
    expect(w.addresses.added).toEqual([]);
    await w.client.add(remoteDraft({ label: 'First', url: 'https://mcp.example.test/mcp', headers: [] }, { newId }));
    await expect(w.client.add(remoteDraft({ label: 'Second', url: 'https://mcp.example.test/mcp/', headers: [] }, { newId }))).rejects.toThrow(/Another server, First, already uses this address/);
    // The exe answers an identical address with the id it already has: refused too, and never removed.
    const w2 = await world({ addresses: { add: async () => ({ id: 'same' }), remove: async () => { throw new Error('must not remove'); } } });
    await w2.client.add(remoteDraft({ label: 'One', url: 'https://mcp.example.test/a', headers: [] }, { newId }));
    await expect(w2.client.add(remoteDraft({ label: 'Two', url: 'https://mcp.example.test/b', headers: [] }, { newId }))).rejects.toThrow(/Another server, One/);
  });
});
