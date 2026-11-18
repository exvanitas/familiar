// The journal harness: H6 to H9 over seeded runs (FAMILIAR_JSEEDS, default 40), each check with a witness.
import { describe, expect, it } from 'vitest';
import { JOURNAL_CHECKS, JOURNAL_WITNESSES } from './journal-checks.ts';
import { journalRun } from './journal.ts';

const SEEDS = Number(process.env.FAMILIAR_JSEEDS ?? 40);

describe('the journal, under seeded actions and kills', () => {
  it(`holds H6 to H9 over ${SEEDS} seeds, each check with a witness`, async () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (let seed = 1; seed <= SEEDS && problems.length <= 8; seed++) {
      const r = await journalRun(seed);
      for (const [name, check] of Object.entries(JOURNAL_CHECKS)) for (const p of check(r)) {
        problems.push(`seed ${seed} ${name}: ${p}`);
        const step = Number(/step (\d+)/.exec(p)?.[1] ?? -1);
        if (process.env.FAMILIAR_VERBOSE && step >= 0)
          for (const c of r.log.filter((c) => c.step >= step - 3 && c.step <= step))
            console.log('C', c.seq, c.life, c.step, !!c.livePre?.run, '->', !!c.livePost?.run, c.livePost?.runFailure ? `${c.livePost.runFailure.reason}:${c.livePost.runFailure.taskId}` : '-', JSON.stringify(c.submissions), c.entries.map((e) => e.kind + (e.model ? '*' : '')).join(','), c.docs.join(','));
      }
      for (const [w, holds] of Object.entries(JOURNAL_WITNESSES)) if (holds(r)) seen.add(w);
    }
    expect(problems).toEqual([]);
    expect(Object.keys(JOURNAL_WITNESSES).filter((w) => !seen.has(w))).toEqual([]);
  }, 600_000);
});
