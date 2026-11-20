// The named schedules, each on a few seeds: the checks hold and the schedule shows what it exists for.
import { describe, expect, it } from 'vitest';
import { H4, PASS_CHECKS, WIRE_CHECKS } from './checks.ts';
import { SCHEDULES } from './schedules.ts';
import { wireRun } from './wire.ts';

describe('the named schedules', () => {
  for (const s of SCHEDULES) {
    it(s.name, async () => {
      const problems: string[] = [];
      for (let seed = 1; seed <= 8; seed++) {
        const r = await wireRun(seed, s.options);
        const checks = s.options.build === 'pass' ? PASS_CHECKS : WIRE_CHECKS;
        for (const [name, check] of Object.entries(checks)) for (const p of check(r)) problems.push(`seed ${seed} ${name}: ${p}`);
        const missing = s.expect?.(r);
        if (missing) problems.push(`seed ${seed}: ${missing}`);
      }
      expect(problems).toEqual([]);
    }, 120_000);
  }

  it('H4 in the pre-pass build: a held helper keeps net_cancel past the bound (a measured limitation)', async () => {
    const s8 = SCHEDULES.find((s) => s.name.startsWith('S8'))!;
    const r = await wireRun(1, s8.options);
    expect(H4(r).length).toBeGreaterThan(0);
    const pass = await wireRun(1, { ...s8.options, build: 'pass' });
    expect(H4(pass)).toEqual([]);
  }, 60_000);
});

describe("the exe's own write bound", () => {
  it('S18 in the pass build with the page watchdog off (no-write-bound): the exe alone stops the server within the bound, and H1 holds', async () => {
    const s18 = SCHEDULES.find((s) => s.name.startsWith('S18'))!;
    const problems: string[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const r = await wireRun(seed, { ...s18.options, build: 'pass', mutation: 'no-write-bound' });
      for (const [name, check] of Object.entries(PASS_CHECKS)) if (name !== 'H4' && name !== 'H5') for (const p of check(r)) problems.push(`seed ${seed} ${name}: ${p}`);
      const missing = s18.expect?.(r);
      if (missing) problems.push(`seed ${seed}: ${missing}`);
    }
    expect(problems).toEqual([]);
  }, 120_000);
});
