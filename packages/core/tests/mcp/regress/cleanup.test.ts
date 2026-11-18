// Cleanup the exe didn't confirm (3.4): a rejected net_cancel, or a rejected server_stop, never frees the
// slot as if the request or the process had ended.
import { describe, expect, it } from 'vitest';
import { LINK_LIMITS, ServerLink, type Target } from '../../../src/mcp/wire/link.ts';
import { fakeNet, fakeProcess, initResult, json, listResult, realClock, textResult } from '../wire-fakes.ts';

const remote: Target = { where: 'remote', address: 'a1', url: 'https://h.example/mcp', headers: [] };
const local: Target = { where: 'local', setup: { id: 's1', label: 'S', program: 'node', args: [], cwd: '.', env: [], secrets: [] } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('cleanup the exe refused', () => {
  it('a rejected net_cancel keeps its request counted: no next exchange is admitted', async () => {
    let refuse = false;
    const net = fakeNet((b) => {
      if (b.method === 'initialize') return json(initResult(b.id));
      if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
      if (b.method === 'tools/list') return json(listResult(b.id, ['look']));
      return json(textResult(b.id, 'ok'));
    });
    const cancel = net.port.cancel.bind(net.port);
    net.port.cancel = async (id) => {
      if (refuse) throw Object.assign(new Error('nope'), { kind: 'failed' });
      return cancel(id);
    };
    const link = new ServerLink('s', { net: net.port }, realClock, { ended: () => {} });
    await link.start(remote, 'L');
    refuse = true;
    expect((await link.handoff('look', '{}', new AbortController().signal, 5000))?.kind).toBe('result');
    await sleep(20);
    expect(link.busy).toBe(true);
    expect(link.handoff('look', '{}', new AbortController().signal, 5000)).toBeUndefined();
  });

  it('a rejected server_stop keeps the run\'s writes open until an exit is seen', async () => {
    const proc = fakeProcess((m) => (m.method === 'tools/call' ? 'hold' : m.method === 'initialize' ? [JSON.stringify(initResult(m.id))] : m.method === 'tools/list' ? [JSON.stringify(listResult(m.id, ['look']))] : []));
    let stopsTried = 0;
    proc.port.stop = async () => {
      stopsTried++;
      throw Object.assign(new Error('nope'), { kind: 'failed' });
    };
    // The write bound ends the run and asks the exe to stop the process, which it refuses.
    const link = new ServerLink('s', { processes: proc.port }, realClock, { ended: () => {} }, { ...LINK_LIMITS, writeMs: 50 });
    await link.start(local, 'L');
    void link.handoff('look', '{}', new AbortController().signal, 60_000);
    await sleep(150);
    // The stop was asked, and refused, before any exit: and the slot is still held.
    expect(stopsTried).toBeGreaterThan(0);
    expect(link.busy).toBe(true);
    proc.exit(0);
    await sleep(10);
    expect(link.busy).toBe(false);
  });
});
