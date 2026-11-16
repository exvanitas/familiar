// The paste parser and the form, as tables: what a person pastes, and the draft that comes out.
import { describe, expect, it } from 'vitest';
import { localDraft, parsePaste, remoteDraft, type Draft } from '../../src/mcp/paste.ts';

let n = 0;
const opts = { newId: () => `id-${++n}`, defaultCwd: 'C:\\work\\home' };
const one = (text: string): Draft => {
  const r = parsePaste(text, opts);
  expect(r.problems).toEqual([]);
  expect(r.drafts).toHaveLength(1);
  return r.drafts[0]!;
};

describe('reading a paste', () => {
  const shapes: [string, string][] = [
    ['the common mcpServers block', '{ "mcpServers": { "files": { "command": "npx", "args": ["-y", "@example/files-server@1.2.3", "C:\\\\work"] } } }'],
    ["VS Code's servers block", '{ "servers": { "files": { "type": "stdio", "command": "npx", "args": ["-y", "@example/files-server@1.2.3", "C:\\\\work"] } } }'],
    ["VS Code's settings, mcp.servers", '{ "mcp": { "servers": { "files": { "command": "npx", "args": ["-y", "@example/files-server@1.2.3", "C:\\\\work"] } } } }'],
    ['a bare map of servers', '{ "files": { "command": "npx", "args": ["-y", "@example/files-server@1.2.3", "C:\\\\work"] } }'],
    ['the inside of a block, without its braces', '"files": { "command": "npx", "args": ["-y", "@example/files-server@1.2.3", "C:\\\\work"] }'],
    ['comments and trailing commas', '{\n  // the files server\n  "mcpServers": { "files": { "command": "npx", /* pinned */ "args": ["-y", "@example/files-server@1.2.3", "C:\\\\work",], }, },\n}']
  ];
  for (const [what, text] of shapes) {
    it(what, () => {
      const d = one(text);
      expect(d.setup).toMatchObject({ kind: 'local', label: 'files', program: 'npx', args: ['-y', '@example/files-server@1.2.3', 'C:\\work'], cwd: 'C:\\work\\home', env: [], secrets: [] });
      expect(d.problems).toEqual([]);
      expect(d.unpinned).toBeUndefined();
    });
  }

  it('one server object, named from its package', () => {
    const d = one('{ "command": "uvx", "args": ["example-time-server==2.0.1"] }');
    expect(d.setup).toMatchObject({ label: 'example-time-server==2.0.1', program: 'uvx' });
  });

  it('several servers give several drafts, each with its own id', () => {
    const r = parsePaste('{ "mcpServers": { "a": { "command": "npx", "args": ["x@1.0.0"] }, "b": { "url": "https://mcp.example.test/mcp" } } }', opts);
    expect(r.drafts.map(d => [d.setup.label, d.setup.kind])).toEqual([['a', 'local'], ['b', 'remote']]);
    expect(r.drafts[0]!.setup.id).not.toBe(r.drafts[1]!.setup.id);
  });

  it('what it refuses, in plain words', () => {
    expect(parsePaste('not json at all', opts).problems[0]).toMatch(/couldn't read that/);
    expect(parsePaste('{ "name": "nothing here" }', opts).problems[0]).toMatch(/names no server/);
    expect(parsePaste('[1, 2]', opts).problems[0]).toMatch(/names no server/);
  });
});

describe('settings and secrets', () => {
  it('every setting is a secret by default, its value kept apart from the setup', () => {
    const d = one('{ "mcpServers": { "gh": { "command": "npx", "args": ["x@1.0.0"], "env": { "GITHUB_TOKEN": "value-one", "OTHER_KEY": "value-two" } } } }');
    expect(d.setup).toMatchObject({ env: [], secrets: ['GITHUB_TOKEN', 'OTHER_KEY'] });
    expect(d.secrets).toEqual([['GITHUB_TOKEN', 'value-one'], ['OTHER_KEY', 'value-two']]);
    expect(JSON.stringify(d.setup)).not.toMatch(/value-one|value-two/);
  });

  it('settings that change what runs are plain only, and short values stay plain with a note', () => {
    const d = one('{ "mcpServers": { "s": { "command": "node", "args": ["server.js"], "env": { "NODE_OPTIONS": "--max-old-space-size=4096", "npm_config_registry": "https://registry.example.test", "LOG_LEVEL": "info", "API_KEY": "value-one" } } } }');
    expect(d.setup).toMatchObject({ env: [['NODE_OPTIONS', '--max-old-space-size=4096'], ['npm_config_registry', 'https://registry.example.test'], ['LOG_LEVEL', 'info']], secrets: ['API_KEY'] });
    expect(d.notes.join(' ')).toMatch(/LOG_LEVEL is too short to keep as a secret/);
    expect(d.problems).toEqual([]);
  });

  it("a README's example value is a problem", () => {
    for (const v of ['<YOUR_TOKEN>', '${input:token}', 'your-api-key-here', 'xxxxxxxx', 'YOUR_API_KEY']) {
      const d = one(JSON.stringify({ mcpServers: { s: { command: 'npx', args: ['x@1.0.0'], env: { TOKEN: v } } } }));
      expect(d.problems.join(' '), v).toMatch(/README's example value/);
    }
  });

  it('a secret value the exe would refuse is a problem in the same terms', () => {
    const marker = one(JSON.stringify({ mcpServers: { s: { command: 'npx', args: ['x@1.0.0'], env: { VALUE_A: 'abc[hidden]defgh' } } } }));
    expect(marker.problems.join(' ')).toMatch(/marker/);
    const ends = one(JSON.stringify({ mcpServers: { s: { command: 'npx', args: ['x@1.0.0'], env: { VALUE_A: 'abcdefgh[hid' } } } }));
    expect(ends.problems.join(' ')).toMatch(/marker/);
    const tab = one(JSON.stringify({ mcpServers: { s: { command: 'npx', args: ['x@1.0.0'], env: { VALUE_A: 'abc\tdefghij' } } } }));
    expect(tab.problems.join(' ')).toMatch(/control character/);
  });

  it('the form gives the same draft as a paste', () => {
    const pasted = one('{ "mcpServers": { "gh": { "command": "npx", "args": ["x@1.0.0"], "env": { "GITHUB_TOKEN": "value-one", "LOG_LEVEL": "info" } } } }');
    const formed = localDraft({ label: 'gh', command: 'npx', args: ['x@1.0.0'], settings: [{ name: 'GITHUB_TOKEN', value: 'value-one', secret: true }, { name: 'LOG_LEVEL', value: 'info', secret: false }] }, opts);
    expect({ ...formed.setup, id: '' }).toEqual({ ...pasted.setup, id: '' });
    expect(formed.secrets).toEqual(pasted.secrets);
  });
});

describe("the exe's limits, early", () => {
  const local = (extra: object) => one(JSON.stringify({ mcpServers: { s: { command: 'npx', args: ['x@1.0.0'], ...extra } } }));
  const cases: [string, object, RegExp][] = [
    ['65 arguments', { args: Array.from({ length: 65 }, (_, i) => `a${i}`) }, /65 arguments\. Familiar takes at most 64/],
    ['an argument with a line break', { args: ['x@1.0.0', 'a\nb'] }, /line break or a NUL/],
    ['two settings differing only in case', { env: { node_options: '--a', NODE_OPTIONS: '--b' } }, /set more than once/],
    ['a setting name with an =', { env: { 'A=B': 'value-long-enough' } }, /isn't a setting name/],
    ['a setting name starting with a digit', { env: { '1ABC': 'value-long-enough' } }, /isn't a setting name/],
    ['33 secrets', { env: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`K${i}`, 'value-long-enough'])) }, /33 secrets/],
    ['a setup over 8 KiB', { args: ['x@1.0.0', 'a'.repeat(9000)] }, /larger than 8 KiB/]
  ];
  for (const [what, extra, words] of cases) it(what, () => expect(local(extra).problems.join(' ')).toMatch(words));

  it('no folder at all', () => {
    const d = parsePaste('{ "command": "npx", "args": ["x@1.0.0"] }', { newId: () => 'x' }).drafts[0]!;
    expect(d.problems).toContain('Choose the folder it runs in.');
  });
});

describe('remote servers', () => {
  it('a bearer key goes to Credential Manager and the header keeps only where it goes', () => {
    const d = one('{ "mcpServers": { "r": { "type": "http", "url": "https://mcp.example.test/mcp", "headers": { "Authorization": "Bearer value-one", "X-Client": "familiar" } } } }');
    expect(d.setup).toMatchObject({ kind: 'remote', url: 'https://mcp.example.test/mcp', transport: 'http', headers: [['X-Client', 'familiar']], key: { header: 'Authorization', prefix: 'Bearer ' } });
    expect(d.key).toBe('value-one');
    expect(JSON.stringify(d.setup)).not.toContain('value-one');
  });

  it('an X-API-Key header, SSE, and the other names for the address', () => {
    const d = one('{ "mcpServers": { "r": { "type": "sse", "serverUrl": "https://mcp.example.test/sse", "headers": { "X-API-Key": "value-one" } } } }');
    expect(d.setup).toMatchObject({ transport: 'sse', url: 'https://mcp.example.test/sse', key: { header: 'X-API-Key', prefix: '' } });
    expect(one('{ "r": { "httpUrl": "https://mcp.example.test/mcp" } }').setup).toMatchObject({ kind: 'remote', url: 'https://mcp.example.test/mcp' });
  });

  it('a key in a header the exe never swaps is refused, and so are two keys', () => {
    expect(one('{ "r": { "url": "https://mcp.example.test/mcp", "headers": { "X-Auth-Token": "value-one" } } }').problems.join(' ')).toMatch(/X-Auth-Token header looks like it carries a key/);
    expect(one('{ "r": { "url": "https://mcp.example.test/mcp", "headers": { "Authorization": "Bearer value-one", "X-API-Key": "value-two" } } }').problems.join(' ')).toMatch(/one key per address/);
  });

  it("addresses the exe would refuse", () => {
    const p = (url: string) => remoteDraft({ label: 'r', url, headers: [] }, opts).problems.join(' ');
    expect(p('https://mcp.example.test/mcp?api_key=abc')).toMatch(/carries a query/);
    const withUser = new URL('https://mcp.example.test/mcp');
    withUser.username = 'someone';
    withUser.password = 'pw';
    expect(p(withUser.href)).toMatch(/user name or password/);
    // A name's reach is the exe's to decide, after the person approves it: only literal addresses here.
    expect(p('http://mcp.example.test/mcp')).toBe('');
    expect(p('http://93.184.216.34/mcp')).toMatch(/must use https/);
    expect(p('http://[2606:4700::1111]/mcp')).toMatch(/must use https/);
    expect(p('http://[::ffff:127.0.0.1]:3000/mcp')).toBe('');
    expect(p('http://[fd00::5]/mcp')).toBe('');
    expect(p('https://169.254.169.254/mcp')).toMatch(/never sends to that address/);
    expect(p('https://[fe80::1]/mcp')).toMatch(/never sends to that address/);
    expect(p('http://fcserver.example.test/mcp')).toBe('');
    expect(p('https://mcp.example.test/a%2fb')).toMatch(/encoded dot or slash/);
    expect(p('not a url')).toMatch(/isn't a web address/);
    expect(p('http://localhost:3000/mcp')).toBe('');
    expect(p('http://192.168.1.20:8080/mcp')).toBe('');
    expect(p('https://mcp.example.test/mcp')).toBe('');
  });
});

describe('credentials are only ever secrets (r19 #1)', () => {
  it('a short credential is refused, never kept as a plain setting', () => {
    const d = one('{ "mcpServers": { "s": { "command": "npx", "args": ["x@1.0.0"], "env": { "API_KEY": "abc123", "LOG_LEVEL": "info" } } } }');
    expect(d.setup).toMatchObject({ env: [['LOG_LEVEL', 'info']], secrets: ['API_KEY'] });
    expect(d.problems.join(' ')).toMatch(/API_KEY is shorter than 8 characters\..*never shows one as a plain setting/);
    expect(JSON.stringify(d.setup)).not.toContain('abc123');
  });

  it('a credential-like name as a plain setting is refused, by form or by edit', () => {
    const formed = localDraft({ label: 's', command: 'npx', args: ['x@1.0.0'], settings: [{ name: 'SERVICE_TOKEN', value: 'value-one', secret: false }] }, opts);
    expect(formed.problems.join(' ')).toMatch(/SERVICE_TOKEN looks like a key or password, so Familiar keeps it only as a secret/);
    for (const name of ['DB_PASSWORD', 'GITHUB_PAT_KEY', 'AUTH_HEADER', 'CLIENT_SECRET', 'SESSION_ID', 'MY_PWD']) {
      const d = localDraft({ label: 's', command: 'npx', args: ['x@1.0.0'], settings: [{ name, value: 'v', secret: false }] }, opts);
      expect(d.problems.join(' '), name).toMatch(/looks like a key or password/);
    }
    // One that changes what runs and looks like a credential can be neither.
    const both = localDraft({ label: 's', command: 'npx', args: ['x@1.0.0'], settings: [{ name: 'NPM_CONFIG__AUTH', value: 'value-one', secret: true }] }, opts);
    expect(both.problems.join(' ')).toMatch(/neither a secret nor a plain setting/);
  });
});

describe("paths, as the exe's syntax takes them (r19 #16)", () => {
  const program = (p: string) => localDraft({ label: 's', command: p, args: [], settings: [] }, opts).problems.join(' ');
  const folder = (c: string) => localDraft({ label: 's', command: 'npx', args: ['x@1.0.0'], cwd: c, settings: [] }, opts).problems.join(' ');
  it('refuses what the exe refuses before touching the disk', () => {
    for (const p of ['C:evil.exe', '\\\\server\\share\\tool.exe', '\\\\?\\C:\\tool.exe', '\\\\.\\C:\\tool.exe', 'C:\\Windows\\..\\tool.exe', 'C:\\tool.exe:stream', 'C:\\COM1\\x.exe', 'C:\\who\u200bami.exe', 'C:/tools/x.exe', 'tools\\x.exe', 'nul']) {
      expect(program(p), p).toMatch(/won't start the program|isn't a program name/);
    }
    for (const c of ['relative', '.', 'C:', 'C:work', '\\\\server\\share', 'C:\\work\\..', 'D:\\a\\con.txt']) expect(folder(c), c).toMatch(/won't run a server in the folder/);
  });

  it('takes plain names and local full paths', () => {
    for (const p of ['npx', 'uvx.exe', 'C:\\Program Files\\nodejs\\npx.cmd', 'D:\\tools\\server.exe']) expect(program(p), p).toBe('');
    for (const c of ['C:\\work\\home', 'D:\\', 'C:\\Program Files\\x']) expect(folder(c), c).toBe('');
  });
});
