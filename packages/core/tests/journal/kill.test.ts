// Kill mid-step, in Node: the engine and its store connection torn down with no shutdown path, then a
// reopen and a resume on the same fake IndexedDB. The same scenarios and the same checks run in headless
// Chromium, with the page closed (browser.test.ts).
import { describe, expect, it } from 'vitest';
import { CHECKS } from './checks.ts';
import { killAndResume, nodeWorld } from './node-env.ts';
import { scenario, WRITE_WINDOW, writeWindowPath, writeWindowProblems } from './scenarios.ts';

describe('kill mid-step, then resume (Node, fake IndexedDB, the engine and its connection torn down)', () => {
  for (const [name, check] of Object.entries(CHECKS)) {
    it(`${name}: ${check.title}`, async () => {
      check.verify((await killAndResume(scenario(name))) as any);
    });
  }
});

// server-reissue's grant is a real one, saved through the client and reloaded from its store: with the
// grant lost on its way to life 2, in saving or in reloading, life 2 asks for a card, and the check fails.
// Life 1's client has a call under way at the kill, its time limit armed: the kill takes that timer with it,
// so nothing of life 1's client fires into life 2.
describe("server-reissue's life 1 client, at the kill", () => {
  it('has a timer armed before the kill, and none after it', async () => {
    const world = nodeWorld();
    await killAndResume(scenario('server-reissue'), world);
    expect(world.counters.get('life1-timers-at-kill')).toBeGreaterThan(0);
    expect(world.counters.get('life1-timers-after-kill')).toBe(0);
  });
});

describe("server-reissue's grant, lost across the reopen (the controls)", () => {
  for (const fault of ['drop-grant-write', 'lose-grant'])
    it(`${fault}: the rerun asks, and the check fails`, async () => {
      const world = nodeWorld();
      world.counters.set(fault, 1);
      const s = (await killAndResume(scenario('server-reissue'), world)) as any;
      expect(() => CHECKS['server-reissue']!.verify(s)).toThrow();
      expect(s.cardsBefore).toBe(0);
      expect(s.cardsAfter).toBe(1);
    });
});

// A built-in write killed at every point of its window: right after each transaction from the tool's
// start to past the turn's end. Whatever the point, exactly one row is committed, and the step's result
// carries that row's token.
describe('a built-in write, killed at every point through its write (Node)', () => {
  it('commits exactly one row, matching its receipt, at every kill point; both paths are taken', async () => {
    const problems: string[] = [];
    const paths = new Set<string>();
    for (let k = 1; k <= 14; k++) {
      const world = nodeWorld();
      world.counters.set('kill-after', k);
      const s = await killAndResume(WRITE_WINDOW, world);
      problems.push(...writeWindowProblems(s).map((p) => `kill after transaction ${k}: ${p}`));
      paths.add(writeWindowPath(s));
    }
    expect(problems).toEqual([]);
    // Kills landed before the write's commit (made again in life 2) and after it (found by its receipt).
    expect(paths).toContain('receipt');
    expect(paths).toContain('made-again');
  }, 60_000);
});
