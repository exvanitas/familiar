// The journal's named schedules. S5: a step cap with a message queued, then a new message, then a delayed
// Yes. (S7 is T13's, in tests/journal; S4 and S6 are listed as open in the phase log.)
import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '../../src/index.ts';
import { JOURNAL_CHECKS } from './journal-checks.ts';
import { journalRun } from './journal.ts';

const tools = (r: ModelRequest) => r.messages.filter((m) => m.role === 'tool').length;
const lastText = (r: ModelRequest) => String(r.messages.at(-1)?.content ?? '');

describe('the journal named schedules', () => {
  it('S5: a step cap with B queued, then C, then the delayed Yes: C closes the question, the Yes does nothing', async () => {
    for (const mutation of [undefined, 'question-at-end'] as const) {
      const r = await journalRun(1, {
        ...(mutation ? { mutation } : {}),
        schedule: async (d) => {
          // Tool rounds until the cap, unless the last message is B or C, which get words.
          d.script = (req) => (/^(B|C)\b/.test(lastText(req)) || !req.tools?.length ? { text: 'Fine.' } : { toolCalls: [{ id: `c${tools(req)}-${req.messages.length}`, name: 'note_add', arguments: { text: `n${req.messages.length}` } }] });
          await d.send('A, note things.');
          await d.awaitModel();
          await d.answerModel();
          await d.send('B, also this.');
          await d.drain(6);
          await d.look();
          const q = d.shownQuestion();
          if (!q) throw new Error(`S5: no cap question: ${d.steps.join(' ')} ${JSON.stringify(d.evidence.filter((e) => e.what === 'shown').at(-1))} ${JSON.stringify(d.rec.log.at(-1)?.livePost)}`);
          await d.send('C, new thing.');
          await d.drain(6);
          await d.answer(true, q);
          await d.drain(6);
        }
      });
      const problems = Object.entries(JOURNAL_CHECKS).flatMap(([name, check]) => check(r).map((p) => `${name}: ${p}`));
      if (mutation === undefined) {
        expect(problems).toEqual([]);
        // The delayed Yes recorded nothing and started nothing.
        const yesStep = r.evidence.find((e) => e.what === 'answer')!.step;
        expect(r.log.filter((c) => c.step === yesStep && (c.answered.length || c.submissions.length))).toEqual([]);
      } else expect(problems.length, `${mutation} under S5`).toBeGreaterThan(0);
    }
  }, 120_000);
});
