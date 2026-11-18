// The interim local write bound (4.3): until the exe's own bound lands, the page stops a server that has
// stopped reading. Past the bound, the oldest write still pending ends the run and stops the process.
import { describe, expect, it } from 'vitest';
import { ServerLink, LINK_LIMITS, type Target } from '../../../src/mcp/wire/link.ts';
import { fakeProcess, initResult, listResult, realClock } from '../wire-fakes.ts';

const local: Target = { where: 'local', setup: { id: 's1', label: 'S', program: 'node', args: [], cwd: '.', env: [], secrets: [] } };

describe('a local server that stops reading', () => {
  it('is stopped once a write has been pending past the bound, its run ends in words, and the slot frees', async () => {
    expect(LINK_LIMITS.writeMs).toBe(10_000);
    let stops = 0;
    const proc = fakeProcess((m) => (m.method === 'tools/call' ? 'hold' : m.method === 'initialize' ? [JSON.stringify(initResult(m.id))] : m.method === 'tools/list' ? [JSON.stringify(listResult(m.id, ['look']))] : []));
    const stop = proc.port.stop.bind(proc.port);
    proc.port.stop = async (run) => {
      stops++;
      return stop(run);
    };
    const ended: string[] = [];
    const link = new ServerLink('s', { processes: proc.port }, realClock, { ended: (_r, f) => ended.push(f.words) }, { ...LINK_LIMITS, writeMs: 100 });
    await link.start(local, 'L');
    const out = await link.handoff('look', '{}', new AbortController().signal, 60_000)!;
    expect(out.kind).toBe('interrupted');
    expect(stops).toBe(1);
    expect(ended[0]).toMatch(/stopped reading/);
    await new Promise((r) => setTimeout(r, 20));
    expect(link.busy).toBe(false);
  }, 10_000);
});
