// T1, T2, T7 (j), T8 and T14 (docs/mcp-design.md 7.4) on the new client: the export list, decisions at the
// handoff, two identical calls each approved once, Test while running, and the wire against the fake
// server in both eras, counting what reaches the server. T3 to T6, T9, T11 and T13 are in owner.test.ts,
// names.property.test.ts, client.test.ts, journal.test.ts, wire*.test.ts and the harness.
import { afterEach, describe, expect, it } from 'vitest';
import { startHttp } from '../../../../tools/fake-mcp-server/src/http.ts';
import { systemClock } from '../../src/journal/journal.ts';
import * as mcp from '../../src/mcp/index.ts';
import { McpClient, parsePaste, type McpClientOptions, type ToolDecision } from '../../src/index.ts';
import { mintDecision } from '../../src/mcp/decision.ts';
import { memorySettingsStore } from '../../src/settings/store.ts';
import { FAKE_MAIN, REPO, testPaths } from './fake.ts';
import { nodeNetPort } from './node-net.ts';
import { nodeProcessPort, type NodeProcessPort } from './node-process.ts';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

let ids = 0;
async function localServer(args: string[] = [], extra: Partial<McpClientOptions> = {}): Promise<{ client: McpClient; port: NodeProcessPort; id: string }> {
  const port = nodeProcessPort({ secret: () => undefined });
  const client = await McpClient.open({
    paths: testPaths,
    store: memorySettingsStore(),
    processes: port,
    net: nodeNetPort(),
    addresses: { add: async () => ({ id: 'addr-1' }), remove: async () => {} },
    secrets: { delete: async () => {} },
    clock: systemClock,
    ...extra
  });
  cleanups.push(() => port.closeAll());
  const { drafts } = parsePaste(JSON.stringify({ mcpServers: { [`Fake ${++ids}`]: { command: process.execPath, args: [FAKE_MAIN, ...args] } } }), { newId: () => `t-${ids}`, defaultCwd: REPO, paths: testPaths });
  const { id } = await client.add(drafts[0]!);
  expect((await client.start(id)).kind).toBe('ready');
  return { client, port, id };
}

const calls = (port: NodeProcessPort) => port.written.filter((l) => l.includes('"tools/call"')).length;
const yes = (client: McpClient, id: string, tool = 'echo', args: unknown = { text: 'hi' }, by: 'asked' | 'own' = 'asked') => mintDecision(client.facts(id, tool, args)!, `step-${Math.random()}`, by);
const signal = () => new AbortController().signal;

describe('T1: the export list', () => {
  it('is fixed; nothing that builds, marks or hands off a call outside send is public', () => {
    expect(Object.keys(mcp).sort()).toMatchInlineSnapshot(`
      [
        "BUILT_IN",
        "BUSY_WORDS",
        "CALL_MS",
        "CALL_MS_MAX",
        "CALL_MS_MIN",
        "CHECKED_AT_TEST",
        "CatalogError",
        "DEVICES",
        "FINDABLE",
        "INVISIBLE",
        "KEY_HEADERS",
        "KEY_PLACEHOLDER",
        "LEGACY_VERSIONS",
        "LINK_LIMITS",
        "MAX_ARGS",
        "MAX_CATALOG_BYTES",
        "MAX_KEY",
        "MAX_MODEL_NAME",
        "MAX_PAGES",
        "MAX_RESULT_CHARS",
        "MAX_SCHEMA_DEPTH",
        "MAX_SCHEMA_NODES",
        "MAX_SECRETS",
        "MAX_SETTINGS",
        "MAX_SETUP_BYTES",
        "MAX_TOOLS",
        "MAX_TOOL_BYTES",
        "MODERN_VERSION",
        "McpClient",
        "OFFERED_VERSION",
        "OWNER_KEY",
        "OWNER_VERSION",
        "Owner",
        "PREREQUISITES",
        "REMOVED_ID_WORDS",
        "SETTINGS_THAT_RUN",
        "SETTING_PREFIXES_THAT_RUN",
        "SSE_WORDS",
        "UNFINISHED_WORDS",
        "WAITING_AFTER_MS",
        "WAITING_WORDS",
        "addressIdentity",
        "canonicalArguments",
        "canonicalJson",
        "changesWhatRuns",
        "checkPrerequisites",
        "checkTools",
        "choiceKey",
        "classV4",
        "classV6",
        "credentialLike",
        "effectiveDescription",
        "exitFailure",
        "folderProblem",
        "fresh",
        "hidden",
        "issueKey",
        "keyBase",
        "keyLike",
        "kindOf",
        "literalClass",
        "localDraft",
        "localPath",
        "missingProgram",
        "modelName",
        "outcomeText",
        "outsideContent",
        "parsePaste",
        "plain",
        "plainJson",
        "posixPaths",
        "prerequisiteOf",
        "processSetupOf",
        "programProblem",
        "remoteDraft",
        "remoteFailure",
        "remoteHeaders",
        "remoteTargetOf",
        "reservedHeader",
        "resultText",
        "sameFacts",
        "secretRefs",
        "secretValueProblem",
        "serverTool",
        "setupFingerprint",
        "setupProblems",
        "sha256",
        "startFailure",
        "toolChanges",
        "toolFingerprint",
        "toolPolicies",
        "touchesAMarker",
        "unpinned",
        "urlProblems",
        "validId",
        "validName",
        "windowsPaths",
        "wrapperPolicy",
      ]
    `);
    for (const inner of ['mintDecision', 'markUsed', 'usable', 'ServerLink', 'ServerRuntime', 'step', 'frame', 'frameCall']) expect(mcp).not.toHaveProperty(inner);
  });
});

describe('T2: decisions at the handoff', () => {
  it('a cast object, a second use, an aborted signal, "never" after minting, "may run on its own" revoked between mint and send: zero handoffs; a fresh one hands off once', async () => {
    const { client, port, id } = await localServer();
    const facts = client.facts(id, 'echo', { text: 'hi' })!;
    // A cast object: the decision's shape, never minted.
    const cast = Object.freeze({ ...facts, step: 's', by: 'asked' }) as unknown as ToolDecision;
    expect((await client.send(cast, signal())).kind).toBe('error');
    // An aborted signal.
    const stopped = new AbortController();
    stopped.abort();
    expect((await client.send(yes(client, id), stopped.signal)).kind).not.toBe('result');
    // "never" after minting, before the send.
    const d1 = yes(client, id);
    client.revoke(id, 'echo', 'never');
    expect(await client.send(d1, signal())).toMatchObject({ kind: 'error' });
    expect(calls(port)).toBe(0);
    // "May run on its own" revoked between mint and send, on another tool: first shown to work, with the grant saved.
    const note = client.tools().find((t) => t.serverName === 'add_note')!;
    // The revoke above saves itself in the background: wait for the owner.
    for (let i = 0; i < 100 && client.owner.busy; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await client.pressOwn({ server: id, tool: 'add_note', fingerprint: note.fingerprint, launch: note.setupFingerprint }).save()).toBe(true);
    expect((await client.send(yes(client, id, 'add_note', { text: 'w' }, 'own'), signal())).kind).toBe('result');
    expect(calls(port)).toBe(1);
    const d2 = yes(client, id, 'add_note', { text: 'x' }, 'own');
    client.revoke(id, 'add_note', 'ask');
    expect(await client.send(d2, signal())).toMatchObject({ kind: 'error' });
    expect(calls(port)).toBe(1);
    // A fresh one hands off once; the same decision again is refused.
    await new Promise((r) => setTimeout(r, 50));
    const d3 = yes(client, id, 'slow', { ms: 1 });
    expect((await client.send(d3, signal())).kind).toBe('result');
    expect(calls(port)).toBe(2);
    expect((await client.send(d3, signal())).kind).toBe('error');
    expect(calls(port)).toBe(2);
  }, 30_000);

  it("another server's decision goes to its own server only, and a decision for a server that's gone hands off nothing", async () => {
    const a = await localServer();
    const b = await localServer();
    // b's decision, sent through a's client: a has no such server, so nothing goes anywhere.
    const fromB = yes(b.client, b.id);
    expect((await a.client.send(fromB, signal())).kind).toBe('error');
    expect(calls(a.port) + calls(b.port)).toBe(0);
  }, 30_000);
});

describe('T7 (j): two identical calls, each approved on its own card', () => {
  it('each go out once (H14\'s positive witness)', async () => {
    const { client, port, id } = await localServer();
    const first = yes(client, id, 'echo', { text: 'same' });
    const second = yes(client, id, 'echo', { text: 'same' });
    expect((await client.send(first, signal())).kind).toBe('result');
    expect((await client.send(second, signal())).kind).toBe('result');
    const sent = port.written.filter((l) => l.includes('"tools/call"')).map((l) => JSON.stringify(JSON.parse(l).params));
    expect(sent).toEqual([sent[0], sent[0]]);
  }, 30_000);
});

describe('T8: Test while running', () => {
  it('is refused, and the running server is left alone', async () => {
    const { client, port, id } = await localServer();
    const before = port.written.length;
    const report = await client.test(id);
    expect(report).toMatchObject({ ok: false, failure: { kind: 'busy', words: 'Stop the server to test it. Test never disturbs a running server.' } });
    expect(port.written.length).toBe(before);
    expect(client.get(id)?.phase).toBe('ready');
  }, 30_000);
});

describe('T14: the wire against the fake server, both eras, counted at the server', () => {
  it('modern-only over stdio: Ready with no initialized; the list and calls carry the envelope', async () => {
    const { client, port, id } = await localServer(['--era', 'modern']);
    const lines = port.written.map((l) => JSON.parse(l));
    expect(lines.filter((m) => m.method === 'notifications/initialized')).toEqual([]);
    expect(lines.filter((m) => m.method === 'initialize')).toHaveLength(1);
    expect((await client.send(yes(client, id), signal())).kind).toBe('result');
    const call = port.written.map((l) => JSON.parse(l)).find((m) => m.method === 'tools/call');
    expect(call.params._meta['io.modelcontextprotocol/protocolVersion']).toBe(mcp.MODERN_VERSION);
  }, 30_000);

  for (const era of ['legacy', 'modern'] as const) {
    it(`${era} over HTTP: no GET, DELETE, error reply or remote cancel reaches the server; a stopped call isn't resent`, async () => {
      const http = await startHttp({ era } as never);
      cleanups.push(() => http.close());
      const seen: { method: string; body: any }[] = [];
      const net = nodeNetPort();
      const counting: mcp.NetPort = {
        ...net,
        fetch: (spec, body) => {
          let parsed: any;
          try {
            parsed = JSON.parse(new TextDecoder().decode(body));
          } catch {
            parsed = undefined;
          }
          seen.push({ method: spec.method, body: parsed });
          return net.fetch(spec, body);
        }
      };
      const client = await McpClient.open({ paths: testPaths, store: memorySettingsStore(), processes: nodeProcessPort({ secret: () => undefined }), net: counting, addresses: { add: async () => ({ id: 'addr-1' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: systemClock });
      const { drafts } = parsePaste(JSON.stringify({ mcpServers: { remote: { type: 'http', url: http.url } } }), { newId: () => `h-${era}` });
      const { id } = await client.add(drafts[0]!);
      expect((await client.start(id)).kind).toBe('ready');
      expect((await client.send(yes(client, id), signal())).kind).toBe('result');
      // The first call's exchange drains (its POST cancelled) before the slot is free again.
      await new Promise((r) => setTimeout(r, 100));
      const stop = new AbortController();
      const slow = client.send(yes(client, id, 'slow', { ms: 5000 }), stop.signal);
      await new Promise((r) => setTimeout(r, 100));
      stop.abort();
      expect((await slow).kind).not.toBe('result');
      await new Promise((r) => setTimeout(r, 100));
      expect(seen.filter((s) => s.method !== 'POST')).toEqual([]);
      expect(seen.filter((s) => s.body?.error !== undefined)).toEqual([]);
      expect(seen.filter((s) => s.body?.method === 'notifications/cancelled')).toEqual([]);
      expect(seen.filter((s) => s.body?.method === 'tools/call' && s.body.params?.name === 'slow')).toHaveLength(1);
      if (era === 'modern') expect(seen.filter((s) => s.body?.method === 'notifications/initialized')).toEqual([]);
      await client.stop(id);
    }, 30_000);
  }
});
