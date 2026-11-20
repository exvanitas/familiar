// A long-lived link keeps nothing per exchange it made (3.4): an exchange waiting for the slot registers a
// waiter for the slot held for good only while it waits, and takes it away when its wait ends.
import { describe, expect, it } from 'vitest';
import { ServerLink, type Target } from '../../../src/mcp/wire/link.ts';
import { mutations } from '../../../src/mutations.ts';
import { fakeNet, initResult, json, listResult, realClock } from '../wire-fakes.ts';

const remote: Target = { where: 'remote', address: 'a1', url: 'https://h.example/mcp', headers: [] };

async function refreshes(n: number): Promise<number> {
  const net = fakeNet((b) => {
    if (b.method === 'initialize') return json(initResult(b.id));
    if (b.method === 'notifications/initialized') return { status: 202, chunks: [] };
    return json(listResult(b.id, ['look']));
  });
  const link = new ServerLink('s', { net: net.port }, realClock, { ended: () => {} });
  expect((await link.start(remote, 'L')).ok).toBe(true);
  for (let i = 0; i < n; i++) {
    await link.drained();
    const r = await link.list();
    if (!Array.isArray(r)) throw new Error((r as { words: string }).words);
  }
  await link.drained();
  return link.waiting;
}

describe("the slot's waiters", () => {
  it('after 1,000 refreshes on one link, none is left when idle', async () => {
    expect(await refreshes(1000)).toBe(0);
  }, 60_000);

  it('the control: a waiter kept after its wait ends piles up, one per exchange', async () => {
    mutations.set(['stuck-waiter-kept']);
    try {
      expect(await refreshes(50)).toBeGreaterThanOrEqual(50);
    } finally {
      mutations.clear();
    }
  });
});
