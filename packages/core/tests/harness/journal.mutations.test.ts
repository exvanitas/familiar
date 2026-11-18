// Each named journal mutation fails its check beside its unmutated twin: on one seed, the mutant's check
// fails, the twin's passes, and the two histories match up to the step where the switch first changed
// behaviour. A mutation with no such seed is a broken control and fails the build.
import { describe, expect, it } from 'vitest';
import { JOURNAL_CHECKS } from './journal-checks.ts';
import { journalRun } from './journal.ts';

const CONTROLS: [string, keyof typeof JOURNAL_CHECKS][] = [
  ['question-at-end', 'H6'],
  ['question-at-end', 'H7'],
  // Shown exactly when due, but under another identity: only H6's check of which question catches it.
  ['question-wrong-id', 'H6'],
  // A late answer to an earlier question answers the one open now: only H7's tie to the answered task
  // catches it.
  ['answer-any-question', 'H7'],
  // DESIGN names H6 for this one. Here H6 catches it in about 1 seed in 60 and H7 in most (the run it starts
  // in the failure's own commit is on no act of yours), so the control is H7's.
  ['after-failed-continue', 'H7'],
  ['split-answer', 'H7'],
  ['auto-placement', 'H7'],
  ['per-message-send-now', 'H7'],
  ['hide-send-now', 'H8'],
  // No control for remark-no-inbox-check: pi-durable 1.5.2 never leaves an idle chat with no failure and
  // input queued (a run's end places it, a failure keeps runFailure), so the empty-inbox check is defence in
  // depth that no schedule can make matter while remark-no-failure-check's control stands.
  ['remark-no-failure-check', 'H9']
];

const MAX_SEEDS = 60;

describe('every named journal mutation fails its check, beside its unmutated twin', () => {
  for (const [mutation, check] of CONTROLS) {
    it(`${mutation} fails ${check}`, async () => {
      const tried: string[] = [];
      for (let seed = 1; seed <= MAX_SEEDS; seed++) {
        const mutant = await journalRun(seed, { mutation });
        if (mutant.firstHit === undefined) continue;
        if (!JOURNAL_CHECKS[check]!(mutant).length) continue;
        const twin = await journalRun(seed);
        const twinFails = JOURNAL_CHECKS[check]!(twin);
        const prefix = mutant.firstHit - 1;
        // The same history up to the first hit: the steps, and every commit's submissions, entries and documents.
        const commits = (j: typeof mutant) => JSON.stringify(j.log.filter((c) => c.step <= prefix).map((c) => [c.step, c.submissions.map((x) => [x.type, x.status, x.requestId ?? null]), c.entries.map((x) => [x.kind, x.model, x.data]), c.docs, c.docValues]));
        const same = JSON.stringify(mutant.steps.slice(0, prefix)) === JSON.stringify(twin.steps.slice(0, prefix)) && commits(mutant) === commits(twin);
        tried.push(`seed ${seed}: twin ${twinFails.length ? 'fails' : 'passes'}, prefix ${same ? 'same' : 'differs'}`);
        if (!twinFails.length && same) return;
      }
      expect.fail(`${mutation}: no seed where ${check} fails only in the mutant (${tried.slice(0, 4).join('; ') || 'the switch never fired or the check never failed'})`);
    }, 600_000);
  }
});
