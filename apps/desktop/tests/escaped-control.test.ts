// security.mcp.secret-json-escaped's positive control, in Node: the check's own body over the real fake
// server through core's Node process port, which blanks literal copies of a secret only, as today's exe
// does. It must fail with the known gap's words; a port that also blanks the JSON-escaped form must pass;
// a server that isn't started, or holds another key, must fail with other words, never pass.
import { afterEach, describe, expect, it } from 'vitest';
import { McpClient, parsePaste, systemClock, type ProcessPort } from '@familiar/core';
import { memorySettingsStore } from '../../../packages/core/src/settings/store.ts';
import { nodeProcessPort } from '../../../packages/core/tests/mcp/node-process.ts';
import { FAKE_MAIN, REPO, testPaths } from '../../../packages/core/tests/mcp/fake.ts';
import { ESCAPED_GAP, escapedCopyCheck } from '../shell-check/escaped.ts';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const KEY = 'fkABCDEFGHIJKL"MNOPQRSTUVWX';
const typed = { head: KEY.slice(0, 10), tail: KEY.slice(-10), length: KEY.length };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A port over core's Node one, with what core heard recorded, and optionally the escaped form blanked. */
function world(blankEscaped: boolean, stored = KEY) {
  const inner = nodeProcessPort({ secret: () => stored });
  cleanups.push(() => inner.closeAll());
  const heard: string[] = [];
  const escaped = JSON.stringify(stored).slice(1, -1);
  const port: ProcessPort = {
    ...inner,
    start: (setup, onEvent) =>
      inner.start(setup, (e) => {
        if (e.t !== 'exit' && blankEscaped) e = { ...e, line: e.line.split(escaped).join('[hidden]') };
        if (e.t !== 'exit') heard.push(e.line);
        onEvent(e);
      })
  };
  return { port, heard };
}

async function added(port: ProcessPort) {
  const client = await McpClient.open({ paths: testPaths, store: memorySettingsStore(), processes: port, net: { fetch: async () => { throw new Error('no net'); }, read: async () => new Uint8Array(0), cancel: async () => {} }, addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: systemClock });
  const { drafts } = parsePaste(JSON.stringify({ mcpServers: { 'Fake server': { command: process.execPath, args: [FAKE_MAIN], env: { FAKE_SECRET: 'typed-later' } } } }), { newId: () => 'mcp-q', defaultCwd: REPO, paths: testPaths });
  const { id } = await client.add(drafts[0]!);
  return { client, id };
}

const outcome = (p: Promise<string>) => p.then((w) => ({ pass: w }), (e: Error) => ({ fail: e.message }));

describe('security.mcp.secret-json-escaped, its positive control', () => {
  it('fails with the known gap\'s words where only literal copies are blanked', async () => {
    const w = world(false);
    const { client, id } = await added(w.port);
    const r = await outcome(escapedCopyCheck(client, w.heard, id, typed, sleep));
    expect(r).toMatchObject({ fail: expect.stringMatching(new RegExp(`^${ESCAPED_GAP}: `)) });
  }, 30_000);

  it('passes where the escaped form is blanked too', async () => {
    const w = world(true);
    const { client, id } = await added(w.port);
    expect(await outcome(escapedCopyCheck(client, w.heard, id, typed, sleep))).toMatchObject({ pass: expect.any(String) });
  }, 30_000);

  it('a server that never starts, or holds another key, fails with other words', async () => {
    const dead = world(true);
    dead.port.start = async () => {
      throw Object.assign(new Error('refused'), { kind: 'declined' });
    };
    const a = await added(dead.port);
    const r1 = await outcome(escapedCopyCheck(a.client, dead.heard, a.id, typed, sleep));
    expect(r1).toMatchObject({ fail: expect.not.stringMatching(new RegExp(`^${ESCAPED_GAP}`)) });
    expect(r1).toMatchObject({ fail: expect.stringMatching(/didn't start/) });
    const other = world(false, 'fkABCDEFGHIJKLMNOPQRSTUVWXY');
    const b = await added(other.port);
    expect(await outcome(escapedCopyCheck(b.client, other.heard, b.id, typed, sleep))).toMatchObject({ fail: expect.stringMatching(/another key/) });
  }, 30_000);
});
