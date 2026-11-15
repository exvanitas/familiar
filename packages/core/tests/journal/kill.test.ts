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
