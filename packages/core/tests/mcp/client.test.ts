// The MCP client against the real fake server, over the Node process adapter (which blanks secrets as the
// exe does) and over HTTP: add, list, call, Stop, a deadline, a crash mid-call, restarts then down, a
// changed tool, a printed secret, and remove with a call in flight.
import { afterEach, describe, expect, it } from 'vitest';
import { startHttp } from '../../../../tools/fake-mcp-server/src/http.ts';
import { OUTSIDE_CONTENT } from '../../../../tools/fake-mcp-server/src/server.ts';
import { systemClock } from '../../src/journal/journal.ts';
import { KEY_PLACEHOLDER, localDraft, McpClient, parsePaste, remoteDraft, toolPolicies, type FetchLike, type McpClientOptions, type ServerTool } from '../../src/index.ts';
import { memorySettingsStore } from '../../src/settings/store.ts';
import { FAKE_MAIN, BLANKED_VALUE, REPO } from './fake.ts';
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
    store,
    processes: port,
    fetchFor: () => fetch,
    addresses: { add: async ({ url }) => { addresses.added.push(url); return { id: `addr-${addresses.added.length}` }; }, remove: async id => { addresses.removed.push(id); } },
    secrets: { delete: async ref => { deleted.push(ref); secrets.delete(ref); } },
    clock: systemClock,
    limits: { backoffMs: 50, stopMs: 3000 },
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
  const { drafts } = parsePaste(paste(env, args), { newId, defaultCwd: REPO });
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
    const saved = JSON.stringify(await w.store.get(`mcp.server.${id}`));
    expect(saved).not.toContain(BLANKED_VALUE);
    expect(saved).toContain('FAKE_SECRET');
    expect(saved).toContain('LOG_LEVEL');

    const report = await w.client.test(id);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.tools.map(t => t.name)).toContain('echo');
    expect(report.tools.every(t => t.fresh && /^[0-9a-f]{64}$/.test(t.fingerprint))).toBe(true);
    // Test stops it again, since it wasn't running.
    expect(w.client.get(id)?.phase).toBe('stopped');
    expect(w.port.asked).toBe(1);

    await w.client.markReviewed(id, report.tools.map(t => t.name));
    expect((await w.client.start(id)).kind).toBe('ready');
    // Approved once: the second start asked nothing.
    expect(w.port.asked).toBe(1);
    const tools = w.client.tools();
    const echo = tools.find(t => t.serverName === 'echo')!;
    expect(echo.name).toBe('Fake_server__echo');
    expect(echo.kind).toBe('server');
    expect(echo.outside).toBe(true);
    expect(echo.fresh).toBe(false);
    expect(echo.readOnlyHint).toBe(true);
    expect(echo.doing({})).toBe('calling echo on Fake server');
    const text = await echo.run({ text: 'hello' }, { id: 's1', write: async () => { throw new Error('no'); } });
    expect(text).toMatch(/^\[Outside content: what the MCP server "Fake server" returned from echo\./);
    expect(text.endsWith('\nhello')).toBe(true);
    const page = await w.client.call(id, 'read_page', {});
    expect(page).toEqual({ kind: 'result', text: OUTSIDE_CONTENT, isError: false });
    const failed = await w.client.call(id, 'fail', {});
    expect(failed).toMatchObject({ kind: 'result', isError: true });
    await expect(tools.find(t => t.serverName === 'fail')!.run({}, { id: 's2', write: async () => { throw new Error('no'); } })).rejects.toThrow(/failed on purpose/);
  });

  it('Stop answers at once and sends the cancellation; a deadline does the same', async () => {
    const w = await world();
    const id = await addFake(w);
    await w.client.start(id);
    const stop = new AbortController();
    const t0 = Date.now();
    const slow = w.client.call(id, 'slow', { ms: 20_000 }, { signal: stop.signal });
    await until(() => sentCalls(w.port, 'slow') === 1);
    stop.abort();
    expect(await slow).toEqual({ kind: 'stopped' });
    expect(Date.now() - t0).toBeLessThan(2000);
    await until(() => w.port.written.some(l => l.includes('notifications/cancelled')));

    const t1 = Date.now();
    expect(await w.client.call(id, 'slow', { ms: 20_000 }, { ms: 1000 })).toEqual({ kind: 'timed-out' });
    expect(Date.now() - t1).toBeLessThan(2500);
    await until(() => w.port.written.filter(l => l.includes('notifications/cancelled')).length === 2);
    // The server is still there for the next call.
    expect(await w.client.call(id, 'echo', { text: 'still here' })).toMatchObject({ kind: 'result', text: 'still here' });
  });

  it('a crash mid-call is answered interrupted, never sent again, and the server restarts', async () => {
    const w = await world();
    const id = await addFake(w);
    await w.client.start(id);
    const before = w.port.pids();
    const outcome = await w.client.call(id, 'crash', {});
    expect(outcome).toEqual({ kind: 'interrupted' });
    await until(() => w.client.get(id)?.phase === 'ready');
    expect(w.port.pids()).not.toEqual(before);
    expect(await w.client.call(id, 'echo', { text: 'after' })).toMatchObject({ kind: 'result', text: 'after' });
    // Sent once, on the run that crashed, and never again.
    expect(sentCalls(w.port, 'crash')).toBe(1);
    // The model's view of it.
    const crash = w.client.tools().find(t => t.serverName === 'crash')!;
    await expect(crash.run({}, { id: 's', write: async () => { throw new Error('no'); } })).rejects.toThrow(/may have partly run\. Familiar did not send it again/);
  });

  it('three crashes in ten minutes: down, with its last output, until the person starts it', async () => {
    const w = await world();
    const id = await addFake(w);
    await w.client.start(id);
    for (let i = 0; i < 3; i++) {
      await until(() => w.client.get(id)?.phase === 'ready');
      expect(await w.client.call(id, 'crash', {})).toEqual({ kind: 'interrupted' });
    }
    await until(() => w.client.get(id)?.phase === 'down');
    const s = w.client.get(id)!;
    expect(s.failure?.kind).toBe('exited');
    expect(s.failure?.words).toContain('exited with code 3');
    expect(s.failure?.lastOutput).toContain('crashing on purpose');
    expect(await w.client.call(id, 'echo', { text: 'x' })).toMatchObject({ kind: 'error', reason: 'down' });
    expect(w.client.tools()).toEqual([]);
    expect((await w.client.start(id)).kind).toBe('ready');
  });

  it('a changed tool goes back to ask, and a new version puts every tool back to ask', async () => {
    const w = await world();
    const id = await addFake(w);
    const first = await w.client.test(id);
    if (!first.ok) throw new Error(first.failure.words);
    await w.client.markReviewed(id, first.tools.map(t => t.name));
    await w.client.start(id);
    const a = w.client.tools();
    // The person said "always" to every tool, for this exact tool and setup.
    const always = Object.fromEntries(a.map(t => [t.name, { policy: 'allow' as const, fingerprint: t.fingerprint, setupFingerprint: t.setupFingerprint }]));
    expect(Object.values(toolPolicies(a, always)).every(p => p === 'allow')).toBe(true);
    await w.client.stop(id);

    // The same server, now variant b: echo's description changed.
    const { drafts } = parsePaste(paste({}, ['--variant', 'b']), { newId, defaultCwd: REPO });
    await w.client.edit(id, drafts[0]!);
    const second = await w.client.test(id);
    if (!second.ok) throw new Error(second.failure.words);
    expect(second.changes.changed).toEqual(['echo']);
    expect(second.tools.filter(t => t.fresh).map(t => t.name)).toEqual(['echo']);
    // The exe asked again, since the arguments changed.
    expect(w.port.asked).toBe(2);
    await w.client.start(id);
    const b = w.client.tools();
    expect(b.filter(t => t.fresh).map(t => t.serverName)).toEqual(['echo']);
    const echo = b.find(t => t.serverName === 'echo')!;
    expect(echo.fingerprint).not.toBe(a.find(t => t.serverName === 'echo')!.fingerprint);
    // A new setup: "always" no longer holds for any tool. Deny would still hold.
    expect(toolPolicies(b, always)).toEqual({});
    expect(toolPolicies(b, { [echo.name]: { policy: 'deny', fingerprint: 'old', setupFingerprint: 'old' } })).toEqual({ [echo.name]: 'deny' });
    // With the setup as it is now, only the changed tool lost its "always".
    const sameSetup = Object.fromEntries(Object.entries(always).map(([k, v]) => [k, { ...v, setupFingerprint: echo.setupFingerprint }]));
    const now = toolPolicies(b, sameSetup);
    expect(now[echo.name]).toBeUndefined();
    expect(Object.keys(now)).toHaveLength(b.length - 1);
  });

  it("print_secret comes back blanked: the reply, the model's text and the last output", async () => {
    const w = await world();
    const id = await addFake(w, { FAKE_SECRET: BLANKED_VALUE });
    await w.client.start(id);
    const r = await w.client.call(id, 'print_secret', {});
    expect(r).toEqual({ kind: 'result', text: 'The secret is [hidden].', isError: false });
    const text = await w.client.tools().find(t => t.serverName === 'print_secret')!.run({}, { id: 's', write: async () => { throw new Error('no'); } });
    expect(text).not.toContain(BLANKED_VALUE);
    await w.client.call(id, 'crash', {});
    await until(() => w.client.get(id)?.phase === 'ready');
    const statuses = JSON.stringify(w.client.list());
    expect(statuses).not.toContain(BLANKED_VALUE);
  });

  it('remove with a call in flight: the call is interrupted, and the approval, secrets and record go', async () => {
    const w = await world();
    const id = await addFake(w, { FAKE_SECRET: BLANKED_VALUE });
    await w.client.start(id);
    const slow = w.client.call(id, 'slow', { ms: 20_000 });
    await until(() => sentCalls(w.port, 'slow') === 1);
    const removed = await w.client.remove(id);
    expect(removed).toEqual({ kind: 'removed' });
    expect(await slow).toEqual({ kind: 'interrupted' });
    expect(w.deleted).toEqual([`server:${id}:FAKE_SECRET`]);
    expect(await w.store.get(`mcp.server.${id}`)).toBeUndefined();
    expect(w.client.list()).toEqual([]);
    expect(w.port.pids()).toEqual([]);
    expect(await w.client.call(id, 'echo', { text: 'x' })).toMatchObject({ kind: 'error', reason: 'removed' });
    // The approval went with it: the same setup asks again.
    const again = await addFake(w);
    await w.client.start(again);
    expect(w.port.asked).toBe(2);
  });

  it('a refused start and a missing program come back in plain words, and nothing retries', async () => {
    const no = await world();
    const port = nodeProcessPort({ ask: () => false });
    cleanups.push(() => port.closeAll());
    const client = await McpClient.open({ store: memorySettingsStore(), processes: port, fetchFor: () => fetch, addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: systemClock });
    const { drafts } = parsePaste(paste(), { newId, defaultCwd: REPO });
    const { id } = await client.add(drafts[0]!);
    const r = await client.test(id);
    expect(r).toEqual({ ok: false, failure: { kind: 'declined', words: 'You chose not to start it.' } });
    expect(client.get(id)?.phase).toBe('stopped');
    expect(port.asked).toBe(1);

    const missing = localDraft({ label: 'Missing', command: 'npx', args: ['-y', 'familiar-no-such-package'], settings: [] }, { newId, defaultCwd: REPO });
    const { id: m } = await no.client.add({ ...missing, setup: { ...missing.setup, kind: 'local', program: 'familiar-no-such-npx' } as typeof missing.setup });
    const r2 = await no.client.test(m);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.failure.words).toContain("Familiar couldn't find the program");

    // A program that exits at once: its last output.
    const quick = localDraft({ label: 'Quick', command: process.execPath, args: ['-e', "console.error('no config file'); process.exit(2)"], settings: [] }, { newId, defaultCwd: REPO });
    const { id: q } = await no.client.add(quick);
    const r3 = await no.client.test(q);
    expect(r3).toMatchObject({ ok: false, failure: { kind: 'exited', words: 'The server exited with code 2. Its last output is below.', lastOutput: 'no config file' } });
  });

  it('the handshake deadline: a program that never speaks MCP', async () => {
    const w = await world({ limits: { initMs: 300, backoffMs: 50, stopMs: 3000 } });
    const silent = localDraft({ label: 'Silent', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], settings: [] }, { newId, defaultCwd: REPO });
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
    const again = await McpClient.open({ store: w.store, processes: w.port, fetchFor: () => fetch, addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: systemClock });
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
    const seen: Headers[] = [];
    const watching: FetchLike = async (url, init) => {
      seen.push(new Headers(init?.headers));
      return fetch(url, init);
    };
    const w = await world({ fetchFor: () => watching });
    const { drafts } = parsePaste(JSON.stringify({ mcpServers: { remote: { type: 'http', url: http.url, headers: { Authorization: 'Bearer remote-k1', 'X-Client': 'familiar-test' } } } }), { newId });
    const draft = drafts[0]!;
    expect(draft.problems).toEqual([]);
    expect(draft.key).toBe('remote-k1');
    const { id, secretRefs } = await w.client.add(draft);
    expect(w.addresses.added).toEqual([http.url]);
    expect(secretRefs).toEqual(['addr:addr-1']);
    expect(JSON.stringify(await w.store.get(`mcp.server.${id}`))).not.toContain('remote-k1');

    expect((await w.client.start(id)).kind).toBe('ready');
    expect(await w.client.call(id, 'echo', { text: 'over http' })).toMatchObject({ kind: 'result', text: 'over http' });
    expect(seen.length).toBeGreaterThan(0);
    for (const h of seen) {
      expect(h.get('authorization')).toBe(`Bearer ${KEY_PLACEHOLDER}`);
      expect(h.get('x-client')).toBe('familiar-test');
    }
    expect((await w.client.remove(id)).kind).toBe('removed');
    expect(w.addresses.removed).toEqual(['addr-1']);
  });

  it('a refused key and an unreachable address come back in plain words', async () => {
    const refusing: FetchLike = async () => new Response('no', { status: 401 });
    const w = await world({ fetchFor: () => refusing });
    const { id } = await w.client.add(remoteDraft({ label: 'Refusing', url: 'https://mcp.example.test/mcp', headers: [['Authorization', 'Bearer some-key1']] }, { newId }));
    const r = await w.client.test(id);
    expect(r).toMatchObject({ ok: false, failure: { kind: 'http' } });
    if (!r.ok) expect(r.failure.words).toContain('HTTP 401');

    const failing: FetchLike = async () => { throw new TypeError("Familiar's fetch failed", { cause: { kind: 'no-key' } }); };
    const w2 = await world({ fetchFor: () => failing });
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
    // Two servers with the same label: the later id gets _2.
    expect(names).toContain('Fake_server__echo');
    expect(names).toContain('Fake_server__echo_2');
    await w.client.stop(b);
    expect(w.client.tools().every(t => t.server.id === a)).toBe(true);
  });
});
