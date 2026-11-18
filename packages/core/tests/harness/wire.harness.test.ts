// The seeded wire harness: H1 to H3 and H10 to H14 over CI's seeds, every check needing a witness.
import { describe, expect, it } from 'vitest';
import { WIRE_CHECKS } from './checks.ts';
import { wireRun } from './wire.ts';

const SEEDS = Number(process.env.FAMILIAR_SEEDS ?? 500);

describe('the wire, under seeded interleavings', () => {
  it(`holds H1 to H3 and H10 to H14 over ${SEEDS} seeds`, async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = await wireRun(seed);
      for (const [name, check] of Object.entries(WIRE_CHECKS)) for (const p of check(r)) problems.push(`seed ${seed} ${name}: ${p}`);
      if (problems.length > 8) break;
    }
    expect(problems).toEqual([]);
  }, 300_000);
});
