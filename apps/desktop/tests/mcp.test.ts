/* The MCP client's ports in the app, and the rules core mirrors from the exe. Core checks a setup early
   with the exe's own limits and lists; these tests read shell-core's source and fail if the two drift. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEVICES, INVISIBLE, KEY_HEADERS, KEY_PLACEHOLDER, MAX_ARGS, MAX_SECRETS, MAX_SETTINGS, MAX_SETUP_BYTES, SETTING_PREFIXES_THAT_RUN, SETTINGS_THAT_RUN } from '@familiar/core';
import { desktopMcpPorts, desktopProcessPort, SERVER_IDLE_MS } from '../src/mcp.ts';
import { PLACEHOLDER } from '../src/net.ts';
import type { AddressSpec, NetSpec, Setup, Shell } from '../src/shell.ts';

const rust = (p: string) => readFileSync(new URL(`../shell-core/src/${p}`, import.meta.url), 'utf8');
const list = (src: string, name: string) => {
  const m = new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  return [...m[1]!.matchAll(/"([^"]*)"/g)].map(x => x[1]);
};
const number = (src: string, name: string) => {
  const m = new RegExp(`pub const ${name}: usize = ([^;]+);`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  return Function(`return ${m[1]!.replace(/_/g, '')}`)() as number;
};

describe("core's copy of the exe's rules", () => {
  const setup = rust('setup.rs');
  const secret = rust('secret.rs');

  it('the settings that change what runs', () => {
    expect([...SETTINGS_THAT_RUN]).toEqual(list(setup, 'UNSAFE_SECRETS'));
    expect([...SETTING_PREFIXES_THAT_RUN]).toEqual(list(setup, 'UNSAFE_SECRET_PREFIXES'));
  });

  it("a setup's limits", () => {
    expect(MAX_ARGS).toBe(number(setup, 'MAX_ARGS'));
    expect(MAX_SETTINGS).toBe(number(setup, 'MAX_SETTINGS'));
    expect(MAX_SECRETS).toBe(number(setup, 'MAX_SECRETS'));
    expect(MAX_SETUP_BYTES).toBe(number(setup, 'MAX_SETUP_BYTES'));
  });

  it('the invisible characters and device names paths refuse', () => {
    const confirm = rust('confirm.rs');
    const ranges = [...(/pub const INVISIBLE: \[\(char, char\); \d+\] = \[([\s\S]*?)\];/.exec(confirm)![1]!).matchAll(/\('\\u\{([0-9A-Fa-f]+)\}', '\\u\{([0-9A-Fa-f]+)\}'\)/g)].map(m => [parseInt(m[1]!, 16), parseInt(m[2]!, 16)]);
    expect(ranges.length).toBe(16);
    expect(INVISIBLE.map(r => [...r])).toEqual(ranges);
    const paths = rust('paths.rs');
    const devices = [...(/const DEVICES: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(paths)![1]!).matchAll(/"([^"]*)"/g)].map(m => m[1]!.replace(/\\u\{([0-9a-f]+)\}/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16))));
    expect([...DEVICES]).toEqual(devices);
  });

  it('the key placeholder and the headers it is swapped in', () => {
    expect(KEY_PLACEHOLDER).toBe(PLACEHOLDER);
    expect(secret).toContain(`pub const PLACEHOLDER: &str = "${KEY_PLACEHOLDER}";`);
    expect([...KEY_HEADERS]).toEqual(list(secret, 'SWAP_HEADERS'));
  });
});

describe('the desktop ports', () => {
  function fakeShell() {
    const calls: [string, unknown][] = [];
    const shell = {
      serverStart: async (setup: Setup, onEvent: unknown) => { calls.push(['serverStart', setup]); expect(typeof onEvent).toBe('function'); return { run: 'r1' }; },
      serverWrite: async (run: string, body: Uint8Array) => { calls.push(['serverWrite', [run, new TextDecoder().decode(body)]]); },
      serverStop: async (run: string) => { calls.push(['serverStop', run]); },
      serverForget: async (id: string) => { calls.push(['serverForget', id]); },
      addressAdd: async (spec: AddressSpec) => { calls.push(['addressAdd', spec]); return { id: 'a1', ...spec, reach: 'public' }; },
      addressRemove: async (id: string) => { calls.push(['addressRemove', id]); },
      secretDelete: async (ref: string) => { calls.push(['secretDelete', ref]); },
      netFetch: async (spec: NetSpec) => { calls.push(['netFetch', spec]); return { status: 204, statusText: '', headers: [], url: spec.url, redirected: false }; },
      netRead: async () => new Uint8Array(0),
      netCancel: async () => {}
    } as unknown as Shell;
    return { shell, calls };
  }

  it('the process port is the four server commands, the setup passed as the exe takes it', async () => {
    const { shell, calls } = fakeShell();
    const port = desktopProcessPort(shell);
    const setup = { id: 's1', label: 'S', program: 'npx', args: ['x@1.0.0'], cwd: 'C:\\w', env: [['A', '1']] as const, secrets: ['T'] };
    expect(await port.start(setup, () => {})).toEqual({ run: 'r1' });
    await port.write('r1', new TextEncoder().encode('{}\n'));
    await port.stop('r1');
    await port.forget('s1');
    expect(calls).toEqual([
      ['serverStart', { id: 's1', label: 'S', program: 'npx', args: ['x@1.0.0'], cwd: 'C:\\w', env: [['A', '1']], secrets: ['T'] }],
      ['serverWrite', ['r1', '{}\n']],
      ['serverStop', 'r1'],
      ['serverForget', 's1']
    ]);
  });

  it('addresses are of kind server, secrets are only deleted, and the fetch goes to the saved address', async () => {
    const { shell, calls } = fakeShell();
    const ports = desktopMcpPorts(shell);
    expect(await ports.addresses.add({ url: 'https://mcp.example.test/mcp', label: 'R' })).toEqual({ id: 'a1' });
    await ports.addresses.remove('a1');
    await ports.secrets.delete('server:s1:T');
    await ports.fetchFor('a1')('https://mcp.example.test/mcp', { method: 'POST', body: '{}' });
    const spec = calls.find(c => c[0] === 'netFetch')![1] as NetSpec;
    expect(spec).toMatchObject({ address: 'a1', url: 'https://mcp.example.test/mcp', idleMs: SERVER_IDLE_MS });
    expect(calls.slice(0, 3)).toEqual([['addressAdd', { kind: 'server', url: 'https://mcp.example.test/mcp', label: 'R' }], ['addressRemove', 'a1'], ['secretDelete', 'server:s1:T']]);
    expect('secretSet' in ports.secrets).toBe(false);
  });
});
