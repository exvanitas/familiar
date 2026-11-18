// The journal checks on hand-made histories: what H7 accepts as pi-durable's own boundary, and what it
// takes as an answer's start (docs/mcp-design.md 7.2).
import { describe, expect, it } from 'vitest';
import { H7 } from './journal-checks.ts';
import type { JCommit, JEvidence, JRun } from './journal.ts';

let seq = 0;
const commit = (c: Partial<JCommit>): JCommit => ({ seq: ++seq, life: 1, step: 1, livePre: undefined, livePost: undefined, inboxPre: undefined, inboxPost: undefined, submissions: [], entries: [], docs: [], docValues: {}, answered: [], sentNow: [], interrupted: [], ...c });
const run = (log: JCommit[], evidence: JEvidence[] = []): JRun => ({ log, evidence, steps: [], firstHit: undefined, stepCap: 3, problems: [] });
const live = (taskId: number, first: number, inputs: number[]) => ({ run: { taskId, first, inputs, turns: 0 } });

describe("H7: pi-durable's own boundary", () => {
  it('a new task of the same run (same first input, same inputs) starts nothing new: accepted', () => {
    seq = 0;
    const log = [
      commit({ livePost: live(2, 1, [1]), submissions: [{ id: '1', type: 'input', status: 'placed', requestId: 'r1' }] }),
      commit({ livePre: live(2, 1, [1]), livePost: live(5, 1, [1]) })
    ];
    expect(H7(run(log, [{ step: 1, what: 'send', requestId: 'r1' }]))).toEqual([]);
  });

  it("the next run after the earlier one's inputs settled done: accepted", () => {
    seq = 0;
    const log = [
      commit({ livePost: live(2, 1, [1]), submissions: [{ id: '1', type: 'input', status: 'placed', requestId: 'r1' }] }),
      commit({ submissions: [{ id: '3', type: 'input', status: 'queued', requestId: 'r2' }] }),
      commit({ livePre: live(2, 1, [1]), livePost: live(4, 3, [3]), submissions: [{ id: '1', type: 'input', status: 'done', requestId: 'r1' }, { id: '3', type: 'input', status: 'placed', requestId: 'r2' }] })
    ];
    expect(H7(run(log, [{ step: 1, what: 'send', requestId: 'r1' }, { step: 2, what: 'send', requestId: 'r2' }]))).toEqual([]);
  });

  it("a new run while the earlier run's input isn't settled done, with nothing unanswered in the commit: refused", () => {
    seq = 0;
    const log = [
      commit({ livePost: live(2, 1, [1]), submissions: [{ id: '1', type: 'input', status: 'placed', requestId: 'r1' }] }),
      commit({ submissions: [{ id: '3', type: 'input', status: 'queued', requestId: 'r2' }] }),
      commit({ livePre: live(2, 1, [1]), livePost: live(4, 3, [3]), submissions: [{ id: '3', type: 'input', status: 'placed', requestId: 'r2' }] })
    ];
    expect(H7(run(log, [{ step: 1, what: 'send', requestId: 'r1' }, { step: 2, what: 'send', requestId: 'r2' }]))).toEqual([expect.stringMatching(/commit 3 .*started a run on no act of yours/)]);
  });
});

describe("H7: an answer's start is tied to the question clicked", () => {
  // A step cap ends run 2 with its input unanswered: the question due is run:2.
  const ended = () => [
    commit({ livePost: live(2, 1, [1]), submissions: [{ id: '1', type: 'input', status: 'placed', requestId: 'r1' }] }),
    commit({ livePre: live(2, 1, [1]), livePost: { runFailure: { taskId: 2, inputs: [1] } }, submissions: [{ id: '1', type: 'input', status: 'unanswered', reason: 'turn_limit', requestId: 'r1' }] })
  ];
  const answered = (requestId: string) => commit({ livePre: { runFailure: { taskId: 2, inputs: [1] } }, livePost: live(7, 6, [6]), answered: ['2'], submissions: [{ id: '6', type: 'continue', status: 'placed', requestId }] });

  it('an answer to the question due, clicked on that question: accepted', () => {
    seq = 0;
    const log = [...ended(), answered('a1')];
    expect(H7(run(log, [{ step: 1, what: 'send', requestId: 'r1' }, { step: 2, what: 'answer', requestId: 'a1', question: 'run:2', yes: true }]))).toEqual([]);
  });

  it('the same record and start, but the person clicked an earlier question: refused', () => {
    seq = 0;
    const log = [...ended(), answered('a1')];
    expect(H7(run(log, [{ step: 1, what: 'send', requestId: 'r1' }, { step: 2, what: 'answer', requestId: 'a1', question: 'run:0', yes: true }]))).toEqual([expect.stringMatching(/commit 3 .*clicked run:0/)]);
  });
});
