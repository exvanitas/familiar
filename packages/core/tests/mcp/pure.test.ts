// The MCP client's small pure parts: the unpinned flag, model names, fingerprints and hashing, the
// secret value rules, the plain words for failures, and the prerequisites check.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../../src/mcp/hash.ts';
import { CHECKED_AT_TEST, checkPrerequisites, FINDABLE, prerequisiteOf } from '../../src/mcp/prerequisites.ts';
import { outcomeText, toolChanges, toolFingerprint } from '../../src/mcp/server-tools.ts';
import { issueKey, keyBase, modelName } from '../../src/mcp/owner.ts';
import { CatalogError, checkTools, effectiveDescription } from '../../src/mcp/catalog.ts';
import { posixPaths, windowsPaths } from '../../src/mcp/native-rules.ts';
import { REPO, testPaths } from './fake.ts';
import { callResult, resultText as textOf } from '../../src/mcp/wire/parse.ts';
const resultText = (r: Record<string, unknown>) => textOf(callResult(r));
import { secretValueProblem, setupFingerprint, touchesAMarker, type LocalSetup, type RemoteSetup } from '../../src/mcp/setup.ts';
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

describe('model names: frozen keys (5.9)', () => {
  it('a key is a lower-case letter, then letters and digits, at most 16, from the label; "server" with no Latin letter', () => {
    expect(keyBase('Fichiers été / 2')).toBe('fichiersete2');
    expect(keyBase('42 tools')).toBe('tools');
    expect(keyBase('')).toBe('server');
    expect(keyBase('日本語')).toBe('server');
    expect(keyBase('A very long server label indeed')).toBe('averylongserverl');
    expect(keyBase('Under_score-dash')).toBe('underscoredash');
  });

  it('keys are unique against every key ever issued, by a digit suffix, within 16 characters', () => {
    expect(issueKey('Same', [])).toBe('same');
    expect(issueKey('Same', ['same'])).toBe('same2');
    expect(issueKey('Same', ['same', 'same2'])).toBe('same3');
    expect(issueKey('A very long server label', ['averylongserverl'])).toBe('averylongserver2');
  });

  it("a model name is <key>__<tool's own name>, offered only if the name is letters, digits, _ and -, and fits 64", () => {
    expect(modelName('files', 'read_file')).toEqual({ name: 'files__read_file' });
    expect(modelName('files', 'read file')).toMatchObject({ reason: expect.stringMatching(/can't call/) });
    expect(modelName('files', 'x'.repeat(58))).toMatchObject({ reason: expect.stringMatching(/too long/) });
    expect(modelName('files', 'x'.repeat(57))).toEqual({ name: `files__${'x'.repeat(57)}` });
    // The key has no `_`, so the first `__` splits a name back into one server and one tool.
    const n = (modelName('files', 'a__b') as { name: string }).name;
    expect(n.slice(0, n.indexOf('__'))).toBe('files');
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

  it("a tool's name, title, description or inputs change its fingerprint; key order doesn't", () => {
    const base = { name: 'echo', description: 'Repeats.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
    const fp = toolFingerprint(base);
    expect(toolFingerprint({ ...base, inputSchema: { properties: { text: { type: 'string' } }, type: 'object' } })).toBe(fp);
    expect(toolFingerprint({ ...base, description: 'Repeats in capitals.' })).not.toBe(fp);
    expect(toolFingerprint({ ...base, name: 'echo2' })).not.toBe(fp);
    expect(toolFingerprint({ ...base, title: 'Echo' })).not.toBe(fp);
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

  it("a remote setup's fingerprint covers where its key goes, prefix included: a new prefix drops \"always\"", () => {
    const r: RemoteSetup = { kind: 'remote', id: 'r', label: 'R', url: 'https://h.example/mcp', transport: 'http', headers: [], key: { header: 'Authorization', prefix: 'Bearer ' } };
    const fp = setupFingerprint(r);
    expect(setupFingerprint({ ...r, label: 'Renamed', key: { header: 'authorization', prefix: 'Bearer ' } })).toBe(fp);
    expect(setupFingerprint({ ...r, key: { header: 'Authorization', prefix: 'Token ' } })).not.toBe(fp);
    expect(setupFingerprint({ ...r, key: { header: 'X-API-Key', prefix: 'Bearer ' } })).not.toBe(fp);
  });

  it("a modern remote run's tool fingerprint covers its header declarations and era: the same tool listed by a legacy run, or with other declarations, is another tool", () => {
    const raw = [{ name: 'look', description: 'Looks.', inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } } }];
    const legacy = checkTools(raw)[0]!.fingerprint;
    const modern = checkTools(raw, { declarations: new Map([['look', [{ path: ['region'], name: 'Region', type: 'string' }]]]) })[0]!.fingerprint;
    const none = checkTools(raw, { declarations: new Map() })[0]!.fingerprint;
    const other = checkTools(raw, { declarations: new Map([['look', [{ path: ['region'], name: 'Zone', type: 'string' }]]]) })[0]!.fingerprint;
    expect(legacy).toBe(toolFingerprint(raw[0]!));
    expect(new Set([legacy, modern, none, other]).size).toBe(4);
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
    const rows = await checkPrerequisites({ find: async p => (p === 'npx' ? 'found' : p === 'docker' ? 'not-found' : 'unknown') });
    expect(rows.map(r => r.found)).toEqual(['found', 'unknown', 'not-found']);
    expect(rows[2]!.words).toMatch(/Docker isn't installed.*Docker Desktop/);
    expect(prerequisiteOf('C:\\Program Files\\nodejs\\npx.cmd')?.id).toBe('node');
    expect(prerequisiteOf('uvx.exe')?.id).toBe('uv');
    expect(prerequisiteOf('python')).toBeUndefined();
    // Only the fixed names are ever asked about.
    const asked: string[] = [];
    await checkPrerequisites({ find: async p => { asked.push(p); return 'unknown'; } });
    expect([...new Set(asked)].sort()).toEqual([...FINDABLE].sort());
  });
});

describe('unpinned secondary packages (r19 #17)', () => {
  const cases: [string, string[], string][] = [
    ['npm', ['exec', '--package', 'server@latest', '--', 'server'], 'server@latest'],
    ['npm', ['x', 'some-server'], 'some-server'],
    ['npm', ['--yes', 'exec', '--package=server@1.0.0', '--package=helper', '--', 'server'], 'helper'],
    ['npx', ['-p', 'server@1.0.0', '-p', 'helper', 'server'], 'helper'],
    ['pnpm', ['dlx', '--package', 'server@1.0.0', '--package', 'helper@^2', 'server'], 'helper@^2'],
    ['uvx', ['--with', 'extra-package', 'server@1.2.3'], 'extra-package'],
    ['uvx', ['--with=extra-package>=2', '--from', 'server==1.2.3', 'run'], 'extra-package>=2'],
    ['uv', ['tool', 'run', '--with', 'extra', 'server==1.2.3'], 'extra']
  ];
  for (const [program, args, what] of cases) it(`flags ${what} in ${program} ${args.join(' ')}`, () => expect(unpinned(program, args)?.what).toBe(what));
  it('leaves them when every fetched package is pinned', () => {
    expect(unpinned('npm', ['exec', '--package', 'server@1.0.0', '--', 'server'])).toBeUndefined();
    expect(unpinned('uvx', ['--with', 'extra==2.0.0', 'server@1.2.3'])).toBeUndefined();
    expect(unpinned('npm', ['install'])).toBeUndefined();
  });
});

describe('tool lists, bounded before anything hashes them (r19 #6, #10, #11)', () => {
  const tool = (name: string, extra: object = {}) => ({ name, inputSchema: { type: 'object' as const }, ...extra });
  it('a schema nested 10,000 levels fails in plain words, with no stack overflow', () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 10_000; i++) { const next = {}; deep.x = next; deep = next; }
    expect(() => checkTools([tool('deep', { inputSchema: { type: 'object', 'x-extra': root } })])).toThrow(/nested deeper than 32 levels/);
    const wide = { type: 'object', properties: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`p${i}`, { type: 'string' }])) };
    expect(() => checkTools([tool('wide', { inputSchema: wide })])).toThrow(/more than 4000 parts/);
    expect(() => checkTools([tool('long', { description: 'x'.repeat(70_000) })])).toThrow(/Familiar takes at most 65536 for one tool/);
    expect(() => checkTools(Array.from({ length: 129 }, (_, i) => tool(`t${i}`)))).toThrow(/at most 128/);
    try { checkTools([tool('deep', { inputSchema: { type: 'object', 'x-extra': root } })]); } catch (e) { expect(e).toBeInstanceOf(CatalogError); }
  });

  it('two tools with one name fail the list', () => {
    expect(() => checkTools([tool('echo'), tool('echo')])).toThrow(/two tools named echo/);
  });

  it("a title-only tool's fingerprint follows its title, which the model reads as its description", () => {
    const [a] = checkTools([tool('notes', { title: 'Read notes' })]);
    const [b] = checkTools([tool('notes', { title: 'Delete notes' })]);
    expect(a!.fingerprint).not.toBe(b!.fingerprint);
    expect(effectiveDescription(b!)).toBe('Delete notes');
  });
});

describe("the tests' path rules match the machine they run on", () => {
  // The Windows runner's Node and checkout (run 43838005541), which the Linux job never sees.
  const runnerNode = 'C:\\hostedtoolcache\\windows\\node\\22.23.4\\x64\\node.exe';
  const runnerRepo = 'D:\\a\\familiar\\familiar';
  it("windowsPaths takes the runner's paths, and posixPaths refuses them", () => {
    expect(windowsPaths.program(runnerNode)).toBeUndefined();
    expect(windowsPaths.folder(runnerRepo)).toBeUndefined();
    expect(posixPaths.program(runnerNode)).toBeDefined();
    expect(posixPaths.folder(runnerRepo)).toBeDefined();
  });
  it('testPaths takes the paths of this machine', () => {
    expect(testPaths).toBe(process.platform === 'win32' ? windowsPaths : posixPaths);
    expect(testPaths.program(process.execPath)).toBeUndefined();
    expect(testPaths.folder(REPO)).toBeUndefined();
  });
});

describe("the runner's own options only (r20 #7)", () => {
  // A child's own --package (or --with) after the package can't hide an unpinned package.
  const cases: [string, string[], string][] = [
    ['npm', ['exec', '--', 'server@latest', '--package', 'helper@1.0.0'], 'server@latest'],
    ['npx', ['-y', 'server@latest', '--package', 'helper@1.0.0'], 'server@latest'],
    ['npx', ['server', '-p', 'helper@1.0.0'], 'server'],
    ['bunx', ['server@latest', '--package=helper@1.0.0'], 'server@latest'],
    ['pnpm', ['dlx', 'server@latest', '--package', 'helper@1.0.0'], 'server@latest'],
    ['uvx', ['server', '--from', 'server==1.0.0'], 'server'],
    ['uvx', ['server==1.0.0', '--with', 'pinned==1.0.0', '--with', 'extra'], undefined as never]
  ];
  for (const [program, args, what] of cases) it(`${program} ${args.join(' ')}`, () => expect(unpinned(program, args)?.what).toBe(what));
});

describe('a missing secret (5.1, fail closed)', () => {
  it('stops the start, with the secrets named', () => {
    expect(startFailure({ kind: 'no-key', message: 'no-key' }, 'npx', ['API_TOKEN'])).toEqual({ kind: 'refused', words: "A secret this server needs isn't saved (API_TOKEN). Type it in Settings, then start it again." });
  });
});
