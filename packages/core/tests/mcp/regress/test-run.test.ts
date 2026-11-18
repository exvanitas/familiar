// Test acts on its own run only (5.4): a failed catalog write stops the run it was for, a Stop during the
// write means Test reports no success, and Test never stops a run started since.
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../../src/mcp/client.ts';
import type { ProcessPort } from '../../../src/mcp/process.ts';
import type { ServerSetup } from '../../../src/mcp/setup.ts';
import { memorySettingsStore, type SettingsStore } from '../../../src/settings/store.ts';
import { testPaths, REPO } from '../fake.ts';
import { fakeProcess, initResult, listResult, realClock } from '../wire-fakes.ts';

const local = (id: string): ServerSetup => ({ kind: 'local', id, label: `Files ${id}`, program: process.execPath, args: ['x.js'], cwd: REPO, env: [], secrets: [] });

/** Each start a fresh process that answers the handshake and lists `echo`; counts native starts and stops. */
function port() {
  const counts = { starts: 0, stops: 0 };
  const procs = new Map<string, ReturnType<typeof fakeProcess>>();
  const p: ProcessPort = {
    async start(setup, onEvent) {
      const fp = fakeProcess((msg) => (msg.method === 'initialize' ? [JSON.stringify(initResult(msg.id))] : msg.method === 'tools/list' ? [JSON.stringify(listResult(msg.id, ['echo']))] : []));
      const id = `${setup.id}-${++counts.starts}`;
      procs.set(id, fp);
      await fp.port.start(setup, onEvent);
      return { run: id };
    },
    async write(run, bytes) {
      return procs.get(run)!.port.write('p1', bytes);
    },
    async stop(run) {
      counts.stops++;
      return procs.get(run)!.port.stop('p1');
    },
    async forget() {}
  };
  return { port: p, counts };
}

const open = (store: SettingsStore, processes: ProcessPort) =>
  McpClient.open({ store, processes, net: {} as never, addresses: { add: async () => ({ id: 'addr-1' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: realClock, paths: testPaths });

describe("Test and its catalog write", () => {
  it('a catalog write that fails: Test reports the failure, and the server it started is stopped', async () => {
    const store = memorySettingsStore();
    const { port: p, counts } = port();
    const client = await open(store, p);
    await client.add({ setup: local('l1'), problems: [] });
    // From here every write of the record fails, as a full disk would.
    const failing: SettingsStore = { ...store, put: async () => Promise.reject(new Error('quota')), putIf: async () => Promise.reject(new Error('quota')) };
    const two = await open(failing, p);
    const r = await two.test('l1');
    expect(r.ok).toBe(false);
    expect(two.get('l1')!.phase).not.toBe('ready');
    expect(counts.stops).toBe(counts.starts);
  });
});
