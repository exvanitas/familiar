// A long-lived link keeps nothing per exchange it made (3.4): after 1,000 refreshes no person action is left
// waiting, and nothing else waits on a promise.
import { describe, expect, it } from 'vitest';
import { ServerLink, type Target } from '../../../src/mcp/wire/link.ts';
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

  // The old waiters (a promise per exchange racing the slot held for good) are gone: an exchange waiting for
  // the slot is now a step in the lifecycle machine's state, answered by its transitions, so there is no
  // waiter to leave behind and no control to put one back (W checks every waiter is answered once).
});
