// The lifecycle machine's pass 5 rows (docs/mcp-design.md 5.4): one deadline per person action, the
// relaunch's old exchange ended, a late native start bounded, a failed later catalog write kept, an
// orphan's own words, and a Stop during Test's cleanup. Each over the pure machine, with its mutation.
import { describe, expect, it } from 'vitest';
import { failureOf, initialState, next, NOTE_UNSAVED, noteOf, phaseOf, SESSION_ENDED, START_TIMEOUT, STOP_UNCONFIRMED, STOPPED_EARLY, STOPPED_WORDS, type LcEffect, type LcEvent, type LcState } from '../../../src/mcp/wire/lifecycle.ts';
import { ServerLink, LINK_LIMITS, type Target } from '../../../src/mcp/wire/link.ts';
import type { ProcessEvent, ProcessPort } from '../../../src/mcp/process.ts';
import { mutations } from '../../../src/mutations.ts';
import { realClock } from '../wire-fakes.ts';

const F = { kind: 'protocol' as const, words: 'x' };
const idle: LcEvent = { t: 'slot', idle: true };
type Ev = LcEvent | ((s: LcState) => LcEvent);
const cur = (f: (r: NonNullable<LcState['run']>) => LcEvent) => (s: LcState) => f(s.run!);
const start = (mode: 'start' | 'test' = 'start', where: 'local' | 'remote' = 'local', token = 'k1'): LcEvent => ({ t: 'start', token, mode, facts: { record: 'ok', ownerFree: true, where } });

/** Feeds the events; returns the state and every effect, with the last event's effects apart. */
function run(evs: Ev[], s0: LcState = initialState('s')) {
  let s = s0;
  const all: LcEffect[] = [];
  let last: readonly LcEffect[] = [];
  for (const e0 of evs) {
    const e = typeof e0 === 'function' ? e0(s) : e0;
    const r = next(s, e);
    all.push(...r.effects);
    last = r.effects;
    s = r.state;
  }
  return { s, all, last };
}
const answers = (fx: readonly LcEffect[]) => fx.flatMap((x) => (x.t === 'answer' ? [x] : []));
const toReady: Ev[] = [
  cur((r) => ({ t: 'started', run: r.id, ok: true, process: 'p1' })),
  cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'legacy' } })),
  idle,
  cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'ok' } })),
  idle,
  cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'page', more: false, catalog: 'ok' } })),
  idle
];
const toGrace: Ev[] = [
  start(),
  cur((r) => ({ t: 'started', run: r.id, ok: true, process: 'p1' })),
  cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'modern-refusal' } })),
  idle,
  cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'unanswered', failure: F } }))
];
const withMutation = (m: string | undefined, f: () => void) => {
  mutations.set(m ? [m] : []);
  try {
    f();
  } finally {
    mutations.clear();
  }
};

describe('one deadline per person action', () => {
  it('grace keeps the start deadline: Start is answered at its own deadline, whatever is left of grace', () => {
    const g = run(toGrace);
    expect(g.s.run?.step).toBe('grace');
    // The admission's deadline (id 1) is kept aside, not disarmed; grace has its own.
    expect(g.all.filter((x) => x.t === 'disarm')).toEqual([]);
    expect(g.s.run?.saveBy).toBe(1);
    const fired = run([{ t: 'deadline', id: 1 }], g.s);
    expect(answers(fired.last)).toEqual([{ t: 'answer', token: 'k1', reply: { kind: 'failed', failure: START_TIMEOUT } }]);
  });

  for (const mutation of [undefined, 'lc-relaunch-fresh-budget'] as const)
    it(`an exit in grace relaunches under the same deadline: no fresh start budget${mutation ? ` (control: ${mutation} arms one)` : ''}`, () =>
      withMutation(mutation, () => {
        const g = run([...toGrace, { t: 'exit', process: 'p1', failure: F }, cur((r) => ({ t: 'readmit', run: r.id, facts: { ownerFree: true, enabled: true, launch: '' } }))]);
        const armed = g.all.filter((x) => x.t === 'arm' && x.which === 'start').length;
        expect(armed).toBe(mutation ? 2 : 1);
        // The admission's own deadline (id 1) is the relaunch's.
        if (!mutation) expect(g.s.run?.deadline).toEqual({ which: 'start', id: 1 });
      }));

  for (const mutation of [undefined, 'lc-start-waits-cleanup'] as const)
    it(`a Stop during the start: Start is answered at once, in words saying it was stopped before it finished starting; the cleanup goes on (6b.2)${mutation ? ` (control: ${mutation} leaves Start waiting on the cleanup)` : ''}`, () =>
      withMutation(mutation, () => {
        const g = run([start(), ...toReady.slice(0, 3), { t: 'stop', token: 'k2' }]);
        expect(g.s.run?.step).toBe('closing');
        if (mutation) {
          expect(answers(g.last)).toEqual([]);
          return;
        }
        expect(answers(g.last)).toEqual([{ t: 'answer', token: 'k1', reply: { kind: 'failed', failure: STOPPED_EARLY } }]);
        // The Stop still waits for the exit, under its own deadline; the start's deadline is gone.
        expect(g.s.waiters.map((w) => w.kind)).toEqual(['stop']);
        expect(g.s.run?.deadline?.which).toBe('stop');
        expect(g.s.run?.saveBy).toBeUndefined();
        expect(g.last).toContainEqual({ t: 'disarm', id: 1 });
      }));

  it('the first catalog write still saving at the start deadline: Start fails in time\'s words, and the run ends', () => {
    const g = run([start('start', 'remote'), cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'legacy' } })), idle, cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'ok' } })), idle, cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'page', more: false, catalog: 'ok' } })), idle]);
    expect(g.s.run?.firstSave).toBe('pending');
    const fired = run([(s) => ({ t: 'deadline', id: s.run!.saveBy! })], g.s);
    expect(answers(fired.last)).toEqual([{ t: 'answer', token: 'k1', reply: { kind: 'failed', failure: START_TIMEOUT } }]);
    expect(phaseOf(fired.s)).not.toBe('ready');
    // The save settling later changes nothing.
    const after = run([(s) => ({ t: 'saved', gen: s.saving!.gen, outcome: 'failed' })], fired.s);
    expect(after.last).toEqual([]);
  });
});

describe('a native start the exe answers after Stop gave up on it', () => {
  for (const mutation of [undefined, 'lc-late-start-unbounded'] as const)
    it(`the process it starts is stopped under a deadline of its own, then left as an orphan${mutation ? ` (control: ${mutation} waits for ever)` : ''}`, () =>
      withMutation(mutation, () => {
        const g = run([start(), { t: 'stop', token: 'k2' }, cur((r) => ({ t: 'deadline', id: r.deadline!.id })), cur((r) => ({ t: 'started', run: r.id, ok: true, process: 'p1' })), cur((r) => ({ t: 'stop-answered', run: r.id, ok: true }))]);
        expect(g.s.run?.step).toBe('closing');
        if (mutation) {
          expect(g.s.run?.deadline).toBeUndefined();
          return;
        }
        expect(g.s.run?.deadline?.which).toBe('stop');
        const fired = run([cur((r) => ({ t: 'deadline', id: r.deadline!.id }))], g.s);
        expect(fired.s.run).toBeUndefined();
        expect(fired.s.orphans).toEqual([{ run: 's#1', process: 'p1', how: 'unconfirmed' }]);
        expect(phaseOf(fired.s)).toBe('failed');
      }));
});

describe("an orphan's own words", () => {
  it('a stop Windows accepted with no exit: every later Stop and Start says it hasn\'t exited, never that it was refused', () => {
    const g = run([start(), ...toReady, (s) => ({ t: 'saved', gen: s.saving!.gen, outcome: 'saved' }), { t: 'stop', token: 'k2' }, cur((r) => ({ t: 'stop-answered', run: r.id, ok: true })), cur((r) => ({ t: 'deadline', id: r.deadline!.id })), { t: 'stop', token: 'k3' }, start('start', 'local', 'k4')]);
    const words = answers(g.all).slice(-3).map((a) => (a.reply.kind === 'failed' ? a.reply.failure.words : a.reply.kind));
    expect(words).toEqual([STOP_UNCONFIRMED.words, STOP_UNCONFIRMED.words, STOP_UNCONFIRMED.words]);
  });
});

describe("a Stop during Test's own cleanup", () => {
  for (const mutation of [undefined, 'lc-test-ok-after-stop'] as const)
    it(`Test answers no success; still one native stop${mutation ? ` (control: ${mutation} answers it tested)` : ''}`, () =>
      withMutation(mutation, () => {
        const g = run([start('test'), ...toReady, (s) => ({ t: 'saved', gen: s.saving!.gen, outcome: 'saved' }), { t: 'stop', token: 'k2' }, { t: 'exit', process: 'p1', failure: F }]);
        expect(g.all.filter((x) => x.t === 'native-stop')).toHaveLength(1);
        const test = answers(g.all).find((a) => a.token === 'k1')!.reply;
        if (mutation) expect(test.kind).toBe('tested');
        else expect(test).toEqual({ kind: 'failed', failure: { kind: 'exited', words: STOPPED_WORDS } });
        expect(answers(g.all).find((a) => a.token === 'k2')!.reply).toEqual({ kind: 'stopped' });
      }));
});

describe('a later catalog write that fails', () => {
  for (const mutation of [undefined, 'lc-failed-save-dropped'] as const)
    it(`keeps its generation and is tried once more${mutation ? ` (control: ${mutation} drops it)` : ''}`, () =>
      withMutation(mutation, () => {
        const g = run([start(), ...toReady, (s) => ({ t: 'saved', gen: s.saving!.gen, outcome: 'saved' }), cur((r) => ({ t: 'notice', run: r.id })), cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'page', more: false, catalog: 'ok' } })), idle, (s) => ({ t: 'saved', gen: s.saving!.gen, outcome: 'failed' })]);
        if (mutation) {
          expect(g.last).toEqual([]);
          return;
        }
        expect(g.last).toEqual([{ t: 'save', run: 's#1', gen: 2 }]);
        // The retry is due: nothing shown yet (6b.13).
        expect(g.s.run?.unsaved).toBeUndefined();
        expect(noteOf(g.s)).toBeUndefined();
        // A second failure: no third try; the generation is marked unsaved, and noteOf shows it, not failureOf.
        const again = run([(s) => ({ t: 'saved', gen: s.saving!.gen, outcome: 'failed' })], g.s);
        expect(again.last).toEqual([]);
        expect(again.s.run?.unsaved).toBe(2);
        expect(noteOf(again.s)).toBe(NOTE_UNSAVED);
        expect(failureOf(again.s)).toBeUndefined();
        // A newer catalog published: nothing shown, even before it saves; once the run leaves, nothing.
        const newer = run([cur((r) => ({ t: 'notice', run: r.id })), cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'page', more: false, catalog: 'ok' } }))], again.s);
        expect(newer.s.run?.gen).toBe(3);
        expect(noteOf(newer.s)).toBeUndefined();
        const left = run([{ t: 'stop', token: 'k9' }, { t: 'exit', process: 'p1', failure: F }], again.s);
        expect(left.s.run).toBeUndefined();
        expect(noteOf(left.s)).toBeUndefined();
      }));
});

describe("a modern run's recovery answered in the legacy era (6b.10)", () => {
  it('ends the run with session-ended: the era was decided once, at the opening (G29), and no tool list follows', () => {
    const g = run([
      start('start', 'remote'),
      cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'modern-refusal' } })),
      idle,
      cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'page', more: false, catalog: 'ok' } })),
      idle,
      (s) => ({ t: 'saved', gen: s.saving!.gen, outcome: 'saved' }),
      cur((r) => ({ t: 'call-ended', run: r.id, end: 'session-ended' }))
    ]);
    expect(g.s.run?.era).toBe('modern');
    expect(g.s.run?.purpose).toBe('recovery');
    const after = run([cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'legacy' } }))], g.s);
    expect(after.last.filter((x) => x.t === 'admin')).toEqual([]);
    expect(after.s.run).toBeUndefined();
    expect(failureOf(after.s)).toEqual(SESSION_ENDED);
    expect(after.last).toContainEqual({ t: 'ended', run: 's#1', failure: SESSION_ENDED });
  });
});

describe('an exchange taken behind the fence is ended when the run finishes (6b.12)', () => {
  const ends = (fx: readonly LcEffect[]) => fx.filter((x) => x.t === 'end-live');
  for (const mutation of [undefined, 'lc-taken-not-ended'] as const)
    it(`a ping that took the slot after Stop began is ended by the refused stop that ends the run${mutation ? ` (control: ${mutation} leaves it live)` : ''}`, () =>
      withMutation(mutation, () => {
        const g = run([start(), { t: 'stop', token: 'k2' }, cur((r) => ({ t: 'started', run: r.id, ok: true, process: 'p1' })), { t: 'slot', idle: false }, cur((r) => ({ t: 'stop-answered', run: r.id, ok: false }))]);
        expect(g.s.run).toBeUndefined();
        expect(ends(g.last)).toEqual(mutation ? [] : [{ t: 'end-live', run: 's#1' }]);
      }));
  it('and by the exit that ends it', () => {
    const g = run([start(), ...toReady, (s) => ({ t: 'saved', gen: s.saving!.gen, outcome: 'saved' }), { t: 'stop', token: 'k2' }, { t: 'slot', idle: false }, { t: 'exit', process: 'p1', failure: F }]);
    expect(ends(g.last)).toEqual([{ t: 'end-live', run: 's#1' }]);
  });
  it('no second end-live when nothing took the slot after the fence, or it was freed', () => {
    const plain = run([start(), ...toReady, (s) => ({ t: 'saved', gen: s.saving!.gen, outcome: 'saved' }), { t: 'stop', token: 'k2' }, { t: 'exit', process: 'p1', failure: F }]);
    expect(ends(plain.all)).toHaveLength(1);
    const freed = run([start(), ...toReady, (s) => ({ t: 'saved', gen: s.saving!.gen, outcome: 'saved' }), { t: 'stop', token: 'k2' }, { t: 'slot', idle: false }, idle, { t: 'exit', process: 'p1', failure: F }]);
    expect(ends(freed.all)).toHaveLength(1);
  });
});

describe("a later write's second failure while the run is closing (6b.13, build9's trace 1)", () => {
  it('marks the generation unsaved and shows it while the run is current; no new save is issued', () => {
    const g = run([start(), ...toReady, (s) => ({ t: 'saved', gen: s.saving!.gen, outcome: 'saved' }), cur((r) => ({ t: 'notice', run: r.id })), cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'page', more: false, catalog: 'ok' } })), idle, (s) => ({ t: 'saved', gen: s.saving!.gen, outcome: 'failed' }), { t: 'stop', token: 'k2' }, (s) => ({ t: 'saved', gen: s.saving!.gen, outcome: 'failed' })]);
    expect(g.s.run?.step).toBe('closing');
    expect(g.s.run?.unsaved).toBe(2);
    expect(noteOf(g.s)).toBe(NOTE_UNSAVED);
    expect(g.last.filter((x) => x.t === 'save')).toEqual([]);
  });
});

describe('the first catalog write fails while a newer one waits behind it (6b.13, closing issues no new save)', () => {
  it('the run ends catalog-failed, and the waiting write is not issued', () => {
    const g = run([start(), cur((r) => ({ t: 'started', run: r.id, ok: true, process: 'p1' })), cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'legacy' } })), idle, cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'ok' } })), idle, cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'page', more: false, catalog: 'ok' } })), idle, cur((r) => ({ t: 'notice', run: r.id })), cur((r) => ({ t: 'admin-done', run: r.id, outcome: { k: 'page', more: false, catalog: 'ok' } })), idle, { t: 'saved', gen: 1, outcome: 'failed' }]);
    expect(g.s.run?.step).toBe('closing');
    expect(g.s.run?.cause).toBe('catalog-failed');
    expect(g.last.filter((x) => x.t === 'save')).toEqual([]);
    expect(g.s.saving).toBeUndefined();
  });
});

describe("the relaunch ends the exited process's exchange", () => {
  const local: Target = { where: 'local', setup: { id: 's1', label: 'S', program: 'node', args: [], cwd: '.', env: [], secrets: [] } };
  for (const mutation of [undefined, 'lc-relaunch-keeps-exchange'] as const)
    it(`a modern-only server that takes the list write and exits: the relaunch lists, and Start is Ready${mutation ? ` (control: ${mutation} strands the slot)` : ''}`, async () => {
      mutations.set(mutation ? [mutation] : []);
      try {
        const emits = new Map<string, (e: ProcessEvent) => void>();
        let starts = 0;
        const lists: string[] = [];
        const port: ProcessPort = {
          async start(_s, on) {
            const r = `p${++starts}`;
            emits.set(r, on);
            return { run: r };
          },
          async write(r, b) {
            const m = JSON.parse(new TextDecoder().decode(b));
            const emit = emits.get(r)!;
            if (m.method === 'initialize') queueMicrotask(() => emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32022, message: 'x', data: { supported: ['2026-07-28'] } } }) }));
            if (m.method === 'tools/list') {
              lists.push(r);
              if (r === 'p1') setTimeout(() => emit({ t: 'exit', code: 0 }), 10);
              else queueMicrotask(() => emit({ t: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', tools: [{ name: 'look', description: 'look', inputSchema: { type: 'object', properties: {} } }] } }) }));
            }
          },
          async stop(r) {
            queueMicrotask(() => emits.get(r)!({ t: 'exit', code: 0 }));
          },
          async forget() {}
        };
        const link = new ServerLink('s', { processes: port }, realClock, { ended: () => {} }, { ...LINK_LIMITS, startMs: 800 });
        const r = await link.start(local, 'L');
        if (mutation) {
          expect(r.ok).toBe(false);
          expect(lists).toEqual(['p1']);
          return;
        }
        expect(r.ok).toBe(true);
        expect(lists).toEqual(['p1', 'p2']);
        expect(link.busy).toBe(false);
        await link.stop();
      } finally {
        mutations.clear();
      }
    });
});
