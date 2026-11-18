// The seeded wire harness: H1 to H3 and H10 to H15 over CI's seeds (500; FAMILIAR_SEEDS=20000 locally),
// the named schedules beside them (and H4, H5 in the pass build), and every check needing a witness.
import { describe, expect, it } from 'vitest';
import { PASS_CHECKS, PASS_WITNESSES, WIRE_CHECKS, WITNESSES, pongFates } from './checks.ts';
import { SCHEDULES } from './schedules.ts';
import { wireRun, type WireRun } from './wire.ts';

const SEEDS = Number(process.env.FAMILIAR_SEEDS ?? 500);

describe('the wire, under seeded interleavings', () => {
  it(`holds H1 to H3 and H10 to H15 over ${SEEDS} seeds and the named schedules, each check with a witness`, async () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    const fates: Record<string, number> = {};
    const judge = (label: string, r: WireRun, pass: boolean) => {
      for (const [name, check] of Object.entries(pass ? PASS_CHECKS : WIRE_CHECKS)) for (const p of check(r)) problems.push(`${label} ${name}: ${p}`);
      for (const [w, holds] of Object.entries({ ...WITNESSES, ...(pass ? PASS_WITNESSES : {}) })) if (!seen.has(w) && holds(r)) seen.add(w);
      for (const [f, n] of Object.entries(pongFates(r))) fates[f] = (fates[f] ?? 0) + n;
    };
    for (let seed = 1; seed <= SEEDS && problems.length <= 8; seed++) judge(`seed ${seed}`, await wireRun(seed), false);
    for (const s of SCHEDULES) for (let seed = 1; seed <= 4; seed++) judge(`${s.name.split(' ')[0]} seed ${seed}`, await wireRun(seed, s.options), s.options.build === 'pass');
    // The pass build over random seeds too, its helpers held often.
    for (let seed = 1; seed <= Math.min(SEEDS, 100); seed++) judge(`pass seed ${seed}`, await wireRun(seed, { build: 'pass', mode: { holdHelpers: 0.5 } }), true);
    expect(problems).toEqual([]);
    const missing = Object.keys({ ...WITNESSES, ...PASS_WITNESSES }).filter((w) => !seen.has(w));
    expect(missing, 'checks with no witness in these seeds').toEqual([]);
    if (process.env.FAMILIAR_VERBOSE) console.log("WITNESSES", [...seen].join("; "), "FATES", JSON.stringify(fates));
    // Departure 6: logged, never judged.
    expect(fates.received).toBeGreaterThan(0);
  }, 600_000);
});
