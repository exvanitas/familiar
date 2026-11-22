// Kill mid-step, in Node: the engine and its store connection torn down with no shutdown path, then a
// reopen and a resume on the same fake IndexedDB. The same scenarios and the same checks run in headless
// Chromium, with the page closed (browser.test.ts).
import { describe, expect, it } from 'vitest';
import { CHECKS } from './checks.ts';
import { killAndResume, nodeWorld } from './node-env.ts';
import { CALL_MS_MAX } from '../../src/index.ts';
import { lifeClocks, scenario, timerApi, WRITE_WINDOW, writeWindowPath, writeWindowProblems } from './scenarios.ts';

describe('kill mid-step, then resume (Node, fake IndexedDB, the engine and its connection torn down)', () => {
  for (const [name, check] of Object.entries(CHECKS)) {
    it(`${name}: ${check.title}`, async () => {
      check.verify((await killAndResume(scenario(name))) as any);
    });
  }
});

// server-reissue's grant is a real one, saved through the client and reloaded from its store: with the
// grant lost on its way to life 2, in saving or in reloading, life 2 asks for a card, and the check fails.
// Life 1's client has a call under way at the kill, its time limit armed. Once life 2 is done, life 1's own
// clock is advanced past that limit: the timer died with its life, so life 1's client writes nothing more to
// its port (no cancel for the call it had under way).
describe("server-reissue's life 1 client, after the kill", () => {
  it('had a timer armed at the kill; each of its timeouts was cleared at the platform, and nothing reaches the old port', async () => {
    const world = nodeWorld();
    // A spy on the platform's own setTimeout and clearTimeout: each timeout the native timers arm (through
    // timerApi, whatever it does), and whether the platform ran it or was asked to clear it.
    const live = new Map<unknown, 'armed' | 'cleared' | 'ran'>();
    const platform = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const set = timerApi.set;
    let inApi = false;
    let killed = false;
    let armedInLife1 = 0;
    let stillArmedAtKill: unknown[] = ['not reached'];
    timerApi.set = (callback, delayMs) => {
      inApi = true;
      try {
        return set(callback, delayMs);
      } finally {
        inApi = false;
      }
    };
    globalThis.setTimeout = ((callback: () => void, delayMs?: number, ...rest: unknown[]) => {
      if (!inApi) return platform.setTimeout(callback, delayMs, ...rest);
      const real: unknown = platform.setTimeout(() => {
        if (live.get(real) === 'armed') live.set(real, 'ran');
        callback();
      }, delayMs);
      live.set(real, 'armed');
      return real;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((real: Parameters<typeof clearTimeout>[0]) => {
      if (live.get(real) === 'armed') live.set(real, 'cleared');
      platform.clearTimeout(real);
    }) as typeof clearTimeout;
    try {
      const s = scenario('server-reissue');
      await killAndResume({ name: s.name, run: async (env) => {
        if (env.life === 2 && !killed) {
          killed = true;
          // Life 1 is killed: every timeout it armed has run or was cleared at the platform by now.
          armedInLife1 = live.size;
          stillArmedAtKill = [...live].filter(([, fate]) => fate === 'armed').map(([real]) => real);
        }
        return s.run(env);
      } }, world);
    } finally {
      timerApi.set = set;
      globalThis.setTimeout = platform.setTimeout;
      globalThis.clearTimeout = platform.clearTimeout;
    }
    expect(armedInLife1).toBeGreaterThan(0);
    expect(stillArmedAtKill).toEqual([]);
    expect(world.counters.get('life1-timers-at-kill')).toBeGreaterThan(0);
    const life1 = lifeClocks.get(world.counters)!.get(1)!;
    // The native scheduler's own queue: every timer life 1 armed was cleared there, not only in the clock.
    expect(life1.native.pending()).toBe(0);
    // And whatever is left of either fires now: life 1's client writes nothing more.
    life1.advance(CALL_MS_MAX + 60_000);
    life1.native.fireAll();
    await new Promise((r) => setTimeout(r, 50));
    expect(world.counters.get('life1-writes-after-kill')).toBe(0);
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
