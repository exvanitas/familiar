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

  it('S6: a step cap with B queued in a chat that compacts: at the journal\'s window only in-turn summaries happen, in both builds', async () => {
    const isSummary = (r: ModelRequest) => r.messages.some((m) => m.role === 'user' && String(m.content).includes('<conversation>'));
    const results: Record<string, { h7: string[]; summaries: number }> = {};
    for (const mutation of [undefined, 'background-compaction'] as const) {
      let summaries = 0;
      const r = await journalRun(1, {
        ...(mutation ? { mutation } : {}),
        // Its own usage near the window: no turn cap, which would pause it before any summary.
        turnTokens: false,
        schedule: async (d) => {
          // Every reply reports a context near the window, so the default policy would compact in the
          // background; B gets words; anything else is a tool round, to the cap.
          d.script = (req) => {
            if (isSummary(req)) {
              summaries++;
              return { text: 'SUMMARY' };
            }
            if (/^(B|Earlier)\b/.test(lastText(req)) || !req.tools?.length) return { text: 'Fine.', usage: { inputTokens: 9000, outputTokens: 5 } };
            return { toolCalls: [{ id: `c${tools(req)}-${req.messages.length}`, name: 'note_add', arguments: { text: `n${req.messages.length}` } }], usage: { inputTokens: 9000, outputTokens: 5 } };
          };
          // A long first exchange: more history than pi-durable's default keepRecentTokens (20000), so a
          // summary has something to cut, while the reported usage stays under the blocking threshold.
          for (let k = 0; k < 4; k++) {
            await d.send(`Earlier notes ${k}: ${'lorem ipsum dolor sit amet '.repeat(1800)}`);
            await d.drain(4);
            await d.look();
          }
          await d.send('A, note things.');
          await d.awaitModel();
          await d.answerModel();
          await d.send('B, also this.');
          await d.drain(8);
          await d.look();
          // Whatever the summary does, let it land, and answer what follows.
          await d.drain(8);
          await d.look();
        }
      });
      results[mutation ?? 'twin'] = { h7: JOURNAL_CHECKS.H7!(r), summaries };
    }
    // What the fake's usage can reach in the journal: its provider's 32000-token window puts the blocking
    // threshold (32000 - 16384) below the default keepRecentTokens (20000), so any history long enough to
    // cut is past blocking first. The chat compacts only inside a turn, in both builds, and nothing is
    // placed: H7 holds even under the mutation. S6's evidence for a background summary landing in an idle,
    // failed chat is B1's probe (tests/journal/pi-durable-b1.test.ts, at a 100000 window) with the settings
    // pins: backgroundTokens 0, no model override, and the engine run with exactly those (tests/journal/pins.test.ts).
    expect(results.twin!.summaries).toBeGreaterThan(0);
    expect(results['background-compaction']!.summaries).toBe(results.twin!.summaries);
    expect(results.twin!.h7).toEqual([]);
    expect(results['background-compaction']!.h7).toEqual([]);
  }, 120_000);
});
