// The MCP client's small pure parts: the unpinned flag, model names, fingerprints and hashing, the
// secret value rules, the plain words for failures, and the prerequisites check.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../../src/mcp/hash.ts';
import { CHECKED_AT_TEST, checkPrerequisites, prerequisiteOf } from '../../src/mcp/prerequisites.ts';
import { modelNames, outcomeText, toolChanges, toolFingerprint } from '../../src/mcp/server-tools.ts';
import { resultText } from '../../src/mcp/session.ts';
import { secretValueProblem, setupFingerprint, touchesAMarker, type LocalSetup } from '../../src/mcp/setup.ts';
import { unpinned } from '../../src/mcp/unpinned.ts';
import { remoteFailure, startFailure } from '../../src/mcp/words.ts';

describe('the unpinned flag', () => {
  const flagged: [string, string[], string][] = [
    ['npx', ['-y', '@example/files-server'], '@example/files-server'],
    ['npx', ['@example/files-server@latest'], '@example/files-server@latest'],
    ['npx', ['-y', 'some-server@^1.2.0'], 'some-server@^1.2.0'],
    ['npx.cmd', ['-y', 'some-server'], 'some-server'],
    ['C:\\Program Files\\nodejs\\npx.cmd', ['some-server'], 'some-server'],
    ['npx', ['--package', 'some-server', 'run-it'], 'some-server'],
    ['npx', ['--package=some-server@next', 'run-it'], 'some-server@next'],
    ['bunx', ['some-server'], 'some-server'],
    ['pnpm', ['dlx', 'some-server'], 'some-server'],
    ['uvx', ['example-time-server'], 'example-time-server'],
    ['uvx', ['--from', 'example-time-server>=1', 'time'], 'example-time-server>=1'],
    ['uv', ['tool', 'run', 'example-time-server'], 'example-time-server'],
    ['docker', ['run', '-i', '--rm', '-e', 'TOKEN', 'example/server'], 'example/server'],
    ['docker', ['run', '-i', '--rm', 'example/server:latest'], 'example/server:latest'],
    ['docker.exe', ['run', '--name', 'x', 'registry.example.test:5000/team/server'], 'registry.example.test:5000/team/server']
  ];
  for (const [program, args, what] of flagged) {
    it(`flags ${program} ${args.join(' ')}`, () => {
      const f = unpinned(program, args);
      expect(f?.what).toBe(what);
      expect(f?.words).toMatch(/can fetch (new code|a new image)/);
      expect(f?.fix).toMatch(/Pin/);
    });
  }
  const pinned: [string, string[]][] = [
    ['npx', ['-y', '@example/files-server@1.2.3', 'C:\\work']],
    ['npx', ['some-server@2.0.0-beta.1']],
    ['bunx', ['some-server@1.0.0']],
    ['pnpm', ['dlx', 'some-server@1.0.0']],
    ['uvx', ['example-time-server==2.0.1']],
    ['uvx', ['example-time-server@2.0.1']],
    ['uvx', ['--from', 'example-time-server==2.0.1', 'time']],
    ['docker', ['run', '-i', '--rm', 'example/server:1.4.2']],
    ['docker', ['run', '-i', `example/server@sha256:${'a'.repeat(64)}`]],
    ['node', ['server.js']],
    ['npx', ['./local-folder']],
    ['C:\\tools\\server.exe', []],
    ['docker', ['ps']]
  ];
  for (const [program, args] of pinned) it(`leaves ${program} ${args.join(' ')}`, () => expect(unpinned(program, args)).toBeUndefined());
});

describe('model names', () => {
  it('namespaced, safe for every provider, at most 64, starting with a letter', () => {
    const names = modelNames([{ id: 'b', label: 'Fichiers été / 2', tools: [{ name: 'read file' }, { name: 'x'.repeat(80) }, { name: '***' }] }]).get('b')!;
    expect(names.get('read file')).toBe('Fichiers_ete_2__read_file');
    for (const n of names.values()) expect(n).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
    expect(names.get('***')).toBe('Fichiers_ete_2__tool');
    expect(modelNames([{ id: 'c', label: '42 tools', tools: [{ name: 't' }] }]).get('c')!.get('t')).toBe('s42_tools__t');
    expect(modelNames([{ id: 'd', label: '', tools: [{ name: 't' }] }]).get('d')!.get('t')).toBe('server__t');
  });

  it('collisions settle the same way whatever order the servers come in', () => {
    const a = { id: 'a', label: 'Same', tools: [{ name: 'echo' }, { name: 'Echo' }] };
    const b = { id: 'b', label: 'Same', tools: [{ name: 'echo' }] };
    const one = modelNames([a, b]);
    const two = modelNames([b, a]);
    expect([...one.get('a')!, ...one.get('b')!]).toEqual([...two.get('a')!, ...two.get('b')!]);
    const all = [...one.get('a')!.values(), ...one.get('b')!.values()];
    expect(new Set(all.map(n => n.toLowerCase())).size).toBe(3);
    expect(one.get('b')!.get('echo')).toBe('Same__echo_3');
    // A cut name that collides still fits.
    const long = { id: 'l', label: 'L', tools: [{ name: 'y'.repeat(70) }, { name: 'y'.repeat(71) }] };
    for (const n of modelNames([long]).get('l')!.values()) expect(n.length).toBeLessThanOrEqual(64);
  });
});

describe('fingerprints', () => {
  it('sha256 matches node:crypto, over text of every kind', () => {
    for (const t of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'été ✓ 𝄞', 'x'.repeat(10_000)]) {
      expect(sha256(t)).toBe(createHash('sha256').update(t, 'utf8').digest('hex'));
    }
  });

  it('canonical JSON sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
  });

  it("a tool's name, description or inputs change its fingerprint; key order and its title don't", () => {
    const base = { name: 'echo', description: 'Repeats.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
    const fp = toolFingerprint(base);
    expect(toolFingerprint({ ...base, inputSchema: { properties: { text: { type: 'string' } }, type: 'object' } })).toBe(fp);
    expect(toolFingerprint({ ...base, description: 'Repeats in capitals.' })).not.toBe(fp);
    expect(toolFingerprint({ ...base, name: 'echo2' })).not.toBe(fp);
    expect(toolFingerprint({ ...base, inputSchema: { type: 'object', properties: { text: { type: 'number' } } } })).not.toBe(fp);
    expect(toolChanges([{ name: 'a', fingerprint: '1' }, { name: 'b', fingerprint: '2' }], [{ name: 'b', fingerprint: '3' }, { name: 'c', fingerprint: '4' }])).toEqual({ added: ['c'], changed: ['b'], removed: ['a'] });
  });

  it("a setup's fingerprint: command, arguments, folder, settings and secret names, not their order or values", () => {
    const s: LocalSetup = { kind: 'local', id: 'x', label: 'X', program: 'npx', args: ['a@1.0.0'], cwd: 'C:\\w', env: [['A', '1'], ['B', '2']], secrets: ['S', 'T'] };
    const fp = setupFingerprint(s);
    expect(setupFingerprint({ ...s, env: [['B', '2'], ['A', '1']], secrets: ['T', 'S'], label: 'Renamed' })).toBe(fp);
    for (const changed of [{ args: ['a@1.0.1'] }, { program: 'uvx' }, { cwd: 'C:\\v' }, { env: [['A', '1'], ['B', '3']] as [string, string][] }, { secrets: ['S'] }]) {
      expect(setupFingerprint({ ...s, ...changed })).not.toBe(fp);
    }
  });
});

describe("secret values, as the exe takes them", () => {
  it('refuses what a marker could complete, and nothing else of that sort', () => {
    for (const v of ['ab[key]cd', '[hidden]', ']abcdefgh', 'ey]abcdefgh', 'abcdefgh[', 'abcdefgh[hidd', 'abcdefgh[k']) expect(touchesAMarker(v), v).toBe(true);
    for (const v of ['abcdefgh', 'a]bcdefgh', 'keyless-value', 'abcdefg[x']) expect(touchesAMarker(v), v).toBe(false);
    expect(secretValueProblem('T', 'short')).toMatch(/shorter than 8/);
    expect(secretValueProblem('T', 'x'.repeat(1025))).toMatch(/longer than 1024/);
    expect(secretValueProblem('T', 'a-value-long-enough')).toBeUndefined();
  });
});

describe('plain words', () => {
  it("every exe start error kind, and what to install for a missing program", () => {
    expect(startFailure({ kind: 'not-found', message: 'x' }, 'npx').words).toMatch(/Node\.js isn't installed.*LTS/);
    expect(startFailure({ kind: 'not-found', message: 'x' }, 'uvx').words).toMatch(/uv isn't installed/);
    expect(startFailure({ kind: 'not-found', message: 'x' }, 'docker').words).toMatch(/Docker isn't installed/);
    for (const kind of ['declined', 'asks-stopped', 'busy', 'unsafe-path', 'unsafe-argument', 'duplicate-setting', 'unsafe-secret', 'start-failed', 'revoked', 'invalid']) {
      const f = startFailure({ kind, message: 'internal words' }, 'npx');
      expect(f.words, kind).not.toMatch(/internal words/);
      expect(f.words.length, kind).toBeGreaterThan(10);
    }
    expect(startFailure(new Error('odd'), 'npx')).toEqual({ kind: 'failed', words: "The server couldn't be started." });
  });

  it("the guarded fetch's kinds and HTTP errors", () => {
    expect(remoteFailure(new TypeError('x', { cause: { kind: 'no-key' } })).words).toMatch(/key isn't saved/);
    expect(remoteFailure(new TypeError('x', { cause: { kind: 'tls' } })).words).toMatch(/certificate/);
    expect(remoteFailure(Object.assign(new Error('Error POSTing to endpoint (HTTP 404): nope'), { code: 404 })).words).toMatch(/HTTP 404/);
    expect(remoteFailure(new Error('Error POSTing to endpoint (HTTP 403): the key echoed abc')).words).toBe('The server refused the key (HTTP 403). Check the key in Settings.');
  });

  it("what the model reads for each outcome", () => {
    expect(outcomeText('S', 't', { kind: 'result', text: 'ok', isError: false })).toMatch(/^\[Outside content/);
    expect(() => outcomeText('S', 't', { kind: 'interrupted' })).toThrow(/may have partly run/);
    expect(() => outcomeText('S', 't', { kind: 'timed-out' })).toThrow(/took too long/);
    expect(() => outcomeText('S', 't', { kind: 'stopped' })).toThrow(/was stopped/);
    expect(() => outcomeText('S', 't', { kind: 'error', reason: 'down', words: 'Down.' })).toThrow('Down.');
  });

  it('result text: text parts, plain notes for the rest, bounded', () => {
    expect(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: '', mimeType: 'image/png' }, { type: 'resource_link', uri: 'file:///x', name: 'x' }] })).toBe('a\n[an image, not shown]\n[a link: file:///x]');
    expect(resultText({ content: [], structuredContent: { n: 1 } })).toBe('{"n":1}');
    const long = resultText({ content: [{ type: 'text', text: 'x'.repeat(40_000) }] });
    expect(long.length).toBeLessThan(33_000);
    expect(long).toMatch(/\[cut: the server sent 40000 characters/);
  });
});

describe('prerequisites', () => {
  it('without a finder, each says it is checked at Test, with what it is for', async () => {
    const rows = await checkPrerequisites();
    expect(rows.map(r => [r.prerequisite.id, r.found])).toEqual([['node', 'unknown'], ['uv', 'unknown'], ['docker', 'unknown']]);
    expect(rows.every(r => r.words.includes(CHECKED_AT_TEST))).toBe(true);
  });

  it('with a finder: found, or not with where to get it', async () => {
    const rows = await checkPrerequisites({ find: async p => (p === 'npx' ? 'found' : p === 'docker' ? 'missing' : 'unknown') });
    expect(rows.map(r => r.found)).toEqual(['found', 'unknown', 'missing']);
    expect(rows[2]!.words).toMatch(/Docker isn't installed.*Docker Desktop/);
    expect(prerequisiteOf('C:\\Program Files\\nodejs\\npx.cmd')?.id).toBe('node');
    expect(prerequisiteOf('uvx.exe')?.id).toBe('uv');
    expect(prerequisiteOf('python')).toBeUndefined();
  });
});
