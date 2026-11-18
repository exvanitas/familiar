// The client over the owner, with fake ports: what a saved record holds, when a start may run, what a
// revoke and Mark reviewed save (docs/mcp-design.md 5.1, 5.4, 5.5).
import { describe, expect, it } from 'vitest';
import { McpClient, type McpClientOptions } from '../../src/mcp/client.ts';
import { Owner, OWNER_KEY, OWNER_VERSION, type OwnerPorts } from '../../src/mcp/owner.ts';
import type { ProcessPort } from '../../src/mcp/process.ts';
import type { ServerSetup } from '../../src/mcp/setup.ts';
import { memorySettingsStore, type SettingsStore } from '../../src/settings/store.ts';
import { testPaths, REPO } from './fake.ts';
import { fakeProcess, initResult, listResult, realClock } from './wire-fakes.ts';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** A local setup the path rules take on any platform. */
const local = (id: string): ServerSetup => ({ kind: 'local', id, label: `Files ${id}`, program: process.execPath, args: ['x.js'], cwd: REPO, env: [], secrets: [] });

const ownerPorts = (store: SettingsStore): OwnerPorts => ({
  store,
  forget: async () => {},
  addresses: { add: async () => ({ id: 'addr-1' }), remove: async () => {}, list: async () => [] },
  secrets: { delete: async () => {} },
  now: () => 0
});

/** A process port where each server's runs answer the handshake and list `echo`. */
function speakingPort(hold?: (id: string, msg: any) => Promise<void> | undefined) {
  const starts: string[] = [];
  const procs = new Map<string, ReturnType<typeof fakeProcess>>();
  const runOf = new Map<string, string>();
  const port: ProcessPort = {
    async start(setup, onEvent) {
      starts.push(setup.id);
      const fp = fakeProcess((msg) => (msg.method === 'initialize' ? [JSON.stringify(initResult(msg.id))] : msg.method === 'tools/list' ? [JSON.stringify(listResult(msg.id, ['echo']))] : []));
      procs.set(setup.id, fp);
      const { run } = await fp.port.start(setup, onEvent);
      const id = `${setup.id}-${starts.length}`;
      runOf.set(id, setup.id);
      void run;
      return { run: id };
    },
    async write(run, bytes) {
      const id = runOf.get(run)!;
      const msg = JSON.parse(new TextDecoder().decode(bytes));
      await hold?.(id, msg);
      return procs.get(id)!.port.write('p1', bytes);
    },
    async stop(run) {
      return procs.get(runOf.get(run)!)!.port.stop('p1');
    },
    async forget() {}
  };
  return { port, starts };
}

async function clientOf(store: SettingsStore, processes: ProcessPort, extra: Partial<McpClientOptions> = {}) {
  return McpClient.open({ store, processes, net: {} as never, addresses: { add: async () => ({ id: 'addr-1' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: realClock, paths: testPaths, ...extra });
}

describe('5.1: a saved setup, as the owner keeps it', () => {
  it("a nested field of the wrong shape makes the record unreadable: it's never started, and the owner stays free", async () => {
    const store = memorySettingsStore();
    const one = await clientOf(store, speakingPort().port);
    await one.add({ setup: local('l1'), problems: [] });
    const doc: any = (await store.get(OWNER_KEY))!.value;
    doc.servers.l1.setup.env = [null];
    doc.servers.l1.enabled = true;
    await store.put(OWNER_KEY, { v: OWNER_VERSION, value: doc });
    const two = await clientOf(store, speakingPort().port);
    expect(two.owner.unreadableServers()).toEqual(['l1']);
    expect(await two.start('l1')).toMatchObject({ kind: 'refused' });
    expect(two.owner.busy).toBe(false);
  });

  it("a start whose target can't be built answers failed and releases the owner", async () => {
    const store = memorySettingsStore();
    const client = await clientOf(store, speakingPort().port);
    await client.add({ setup: local('l1'), problems: [] });
    // A record past the load check that still can't be launched (a test reaches in; nothing else can).
    const real = client.owner.server.bind(client.owner);
    client.owner.server = (id: string) => {
      const s = real(id);
      return s && ({ ...s, setup: { ...s.setup, env: [null] } } as never);
    };
    const r = await client.start('l1');
    expect(r).toMatchObject({ kind: 'failed' });
    expect(client.owner.busy).toBe(false);
    expect(client.get('l1')!.phase).toBe('failed');
  });

  it('each nested field is checked on load', async () => {
    const bad: [string, (s: any) => void][] = [
      ['an argument', (s) => (s.args = [1])],
      ['a setting pair', (s) => (s.env = [['A']])],
      ['a setting value', (s) => (s.env = [['A', 2]])],
      ['a secret name', (s) => (s.secrets = [null])]
    ];
    for (const [what, spoil] of bad) {
      const store = memorySettingsStore();
      const owner = await Owner.open(ownerPorts(store));
      await owner.add(local('l1'));
      const doc: any = (await store.get(OWNER_KEY))!.value;
      spoil(doc.servers.l1.setup);
      await store.put(OWNER_KEY, { v: OWNER_VERSION, value: doc });
      expect((await Owner.open(ownerPorts(store))).unreadableServers(), what).toEqual(['l1']);
    }
    const remoteBad: [string, (s: any) => void][] = [
      ['a header pair', (s) => (s.headers = [['X-A', 1]])],
      ['the key', (s) => (s.key = { header: 'authorization' })],
      ['the address', (s) => (s.address = 7)],
      ['the transport', (s) => (s.transport = 'carrier-pigeon')]
    ];
    for (const [what, spoil] of remoteBad) {
      const store = memorySettingsStore();
      const owner = await Owner.open(ownerPorts(store));
      await owner.add({ kind: 'remote', id: 'r1', label: 'R', url: 'https://h.example/mcp', transport: 'http', headers: [], key: { header: 'authorization', prefix: 'Bearer ' } });
      const doc: any = (await store.get(OWNER_KEY))!.value;
      spoil(doc.servers.r1.setup);
      await store.put(OWNER_KEY, { v: OWNER_VERSION, value: doc });
      expect((await Owner.open(ownerPorts(store))).unreadableServers(), what).toEqual(['r1']);
    }
  });

  it("the owner keeps its own copy: a draft changed after add, or a setup read and changed, changes nothing saved or launched", async () => {
    const store = memorySettingsStore();
    const owner = await Owner.open(ownerPorts(store));
    const setup = local('l1') as any;
    expect(await owner.add(setup)).toEqual({ ok: true });
    setup.args.push('--more');
    expect((owner.server('l1')!.setup as any).args).toEqual(['x.js']);
    (owner.server('l1')!.setup as any).args.push('--more');
    expect((owner.server('l1')!.setup as any).args).toEqual(['x.js']);
    const edited = { ...local('l1'), args: ['y.js'] } as any;
    expect(await owner.edit('l1', edited, true)).toEqual({ ok: true });
    edited.args.push('--more');
    expect((owner.server('l1')!.setup as any).args).toEqual(['y.js']);
    expect(((await store.get(OWNER_KEY))!.value as any).servers.l1.setup.args).toEqual(['y.js']);
  });
});
