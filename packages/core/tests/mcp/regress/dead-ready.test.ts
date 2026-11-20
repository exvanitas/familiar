// A server that exits right after its last list reply is never shown Ready (5.4): the reply and the exit can
// reach core in one synchronous batch (the shell's channel drains every buffered message in one loop).
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../../src/mcp/client.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import type { ServerSetup } from '../../../src/mcp/setup.ts';
import { memorySettingsStore } from '../../../src/settings/store.ts';
import { testPaths, REPO } from '../fake.ts';
import { initResult, listResult, realClock } from '../wire-fakes.ts';

const local: ServerSetup = { kind: 'local', id: 'l1', label: 'Files', program: process.execPath, args: ['x.js'], cwd: REPO, env: [], secrets: [] };

/** The list's reply and the process's exit in one synchronous batch, `gap` ms after the write. */
function port(gap: number): ProcessPort {
  let emit!: (e: ProcessEvent) => void;
  return {
    async start(_s, on) {
      emit = on;
      return { run: 'p1' };
    },
    async write(_r, b) {
      const m = JSON.parse(new TextDecoder().decode(b));
      if (m.method === 'initialize') queueMicrotask(() => emit({ t: 'out', line: JSON.stringify(initResult(m.id)) }));
      if (m.method === 'tools/list')
        setTimeout(() => {
          emit({ t: 'out', line: JSON.stringify(listResult(m.id, ['echo'])) });
          emit({ t: 'exit', code: 1 });
        }, gap);
    },
    async stop() {},
    async forget() {}
  };
}

describe('a dead server is never shown Ready', () => {
  for (const gap of [0, 5])
    it(`the list's reply and the exit in one batch (${gap} ms after the write): the start fails, and the phase is failed`, async () => {
      const client = await McpClient.open({ store: memorySettingsStore(), processes: port(gap), net: {} as never, addresses: { add: async () => ({ id: 'a' }), remove: async () => {} }, secrets: { delete: async () => {} }, clock: realClock, paths: testPaths });
      await client.add({ setup: local, problems: [] });
      const r = await client.start('l1');
      expect(r.kind).toBe('failed');
      expect(client.get('l1')!.phase).toBe('failed');
      expect(client.tools()).toEqual([]);
    });
});
