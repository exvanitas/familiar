// W for the run lifecycle (docs/mcp-design.md 5.4; the machine in src/mcp/wire/lifecycle.ts): an exhaustive
// walk over the pure `next()` with the whole event alphabet at every point, bounded by depth and by small
// counts of each kind of event, checking the invariants at every reached state and on every transition.
// States are deduplicated exactly, by their canonical form (never by a hash alone), and at a small bound the
// count is cross-checked against a walker that doesn't deduplicate. Each guard the machine has for a finding
// has a named mutation; under it the walk must find a violating trace, and the same trace must pass on the
// unmutated machine.
import { describe, expect, it } from 'vitest';
import { callable, initialState, next, phaseOf, type LcEffect, type LcEvent, type LcState } from '../../src/mcp/wire/lifecycle.ts';
import { mutations } from '../../src/mutations.ts';

type Where = 'local' | 'remote';

/** What a trace has used of each bounded kind of event: part of the walk's key, so the bound is exact. */
interface Ctx {
  starts: number;
  tests: number;
  stops: number;
  notices: number;
  pings: number;
  drops: number;
  exhausted: number;
  bounds: number;
  stale: number;
  tokens: number;
}
const CTX0: Ctx = { starts: 0, tests: 0, stops: 0, notices: 0, pings: 0, drops: 0, exhausted: 0, bounds: 0, stale: 0, tokens: 0 };

const canonical = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
};

const FAIL = { kind: 'protocol' as const, words: 'x' };

/** Every event the world may deliver in `s`, given what the trace has used. */
function alphabet(s: LcState, c: Ctx, where: Where): [LcEvent, Ctx][] {
  const out: [LcEvent, Ctx][] = [];
  const add = (e: LcEvent, d: Partial<Ctx> = {}) => out.push([e, { ...c, ...d }]);
  const run = s.run;
  const token = () => `k${c.tokens + 1}`;
  // The person: Start (owner free or busy), Test, Stop; each a bounded number of times.
  if (c.starts < 2) {
    add({ t: 'start', token: token(), mode: 'start', facts: { record: 'ok', ownerFree: true, where } }, { starts: c.starts + 1, tokens: c.tokens + 1 });
    add({ t: 'start', token: token(), mode: 'start', facts: { record: 'ok', ownerFree: false, ownerWords: 'Saving another change.', where } }, { starts: c.starts + 1, tokens: c.tokens + 1 });
  }
  if (c.tests < 1) add({ t: 'start', token: token(), mode: 'test', facts: { record: 'ok', ownerFree: true, where } }, { tests: c.tests + 1, tokens: c.tokens + 1 });
  if (c.stops < 2) add({ t: 'stop', token: token() }, { stops: c.stops + 1, tokens: c.tokens + 1 });
  if (c.exhausted < 1 && where === 'remote' && run) add({ t: 'exhausted', failure: { kind: 'protocol', words: 'Restart Familiar to use it again.' } }, { exhausted: 1 });
  // Stale events from runs that aren't current: each must change nothing (I4).
  if (c.stale < 1) {
    add({ t: 'started', run: `${s.id}#0`, ok: true, process: 'p0' }, { stale: 1 });
    add({ t: 'admin-done', run: `${s.id}#0`, outcome: { k: 'legacy' } }, { stale: 1 });
    add({ t: 'deadline', id: 0 }, { stale: 1 });
    add({ t: 'readmit', run: `${s.id}#0`, ok: true }, { stale: 1 });
  }
  if (s.zombie) add({ t: 'readmit', run: s.zombie, ok: true });
  for (const o of s.orphans) add({ t: 'exit', process: o.process, failure: FAIL });
  if (!run) return out;
  const n = run.native;
  if (n?.start === 'pending') {
    add({ t: 'started', run: run.id, ok: true, process: `p${run.id.split('#')[1]}` });
    add({ t: 'started', run: run.id, ok: false, failure: { kind: 'declined', words: 'Not approved.' } });
  }
  if (n?.stop === 'pending') {
    add({ t: 'stop-answered', run: run.id, ok: true });
    add({ t: 'stop-answered', run: run.id, ok: false });
  }
  if (n?.process && !n.exited) {
    add({ t: 'exit', process: n.process, failure: { kind: 'exited', words: 'exited 1' } });
    if (c.bounds < 1 && run.step !== 'closing') add({ t: 'write-bound', run: run.id }, { bounds: 1 });
  }
  if (s.slot === 'busy' && !run.inFlight) add({ t: 'slot', idle: true });
  if (s.slot === 'idle' && c.pings < 1 && run.step !== 'closing' && (n === undefined || n.start === 'ok')) add({ t: 'slot', idle: false }, { pings: 1 });
  if (run.inFlight) {
    const r = run.id;
    if (run.inFlight.kind === 'initialize') {
      add({ t: 'admin-done', run: r, outcome: { k: 'legacy' } });
      if (where === 'local' || run.purpose === 'recovery') add({ t: 'admin-done', run: r, outcome: { k: 'modern-refusal' } });
      add({ t: 'admin-done', run: r, outcome: { k: 'refused', failure: FAIL } });
    } else if (run.inFlight.kind === 'initialized') {
      add({ t: 'admin-done', run: r, outcome: { k: 'ok' } });
      add({ t: 'admin-done', run: r, outcome: { k: 'unanswered', failure: FAIL } });
    } else {
      if (run.inFlight.page === 1) add({ t: 'admin-done', run: r, outcome: { k: 'page', more: true } });
      add({ t: 'admin-done', run: r, outcome: { k: 'page', more: false, catalog: 'ok' } });
      add({ t: 'admin-done', run: r, outcome: { k: 'page', more: false, catalog: FAIL } });
      add({ t: 'admin-done', run: r, outcome: { k: 'invalid', failure: FAIL } });
      add({ t: 'admin-done', run: r, outcome: { k: 'unanswered', failure: FAIL } });
      if (where === 'remote' && c.drops < 2) add({ t: 'admin-done', run: r, outcome: { k: 'session-ended' } }, { drops: c.drops + 1 });
    }
  }
  if (c.notices < 2 && run.step !== 'closing') add({ t: 'notice', run: run.id }, { notices: c.notices + 1 });
  if (callable(s)) {
    add({ t: 'call-ended', run: run.id, end: 'done' });
    if (where === 'remote' && c.drops < 2) add({ t: 'call-ended', run: run.id, end: 'session-ended' }, { drops: c.drops + 1 });
  }
  if (run.deadline) add({ t: 'deadline', id: run.deadline.id });
  if (run.saveBy !== undefined) add({ t: 'deadline', id: run.saveBy });
  if (s.saving) {
    add({ t: 'saved', gen: s.saving.gen, outcome: 'saved' });
    add({ t: 'saved', gen: s.saving.gen, outcome: 'skipped' });
    add({ t: 'saved', gen: s.saving.gen, outcome: 'failed' });
  }
  if (run.step === 'relaunch') {
    add({ t: 'readmit', run: run.id, ok: true });
    add({ t: 'readmit', run: run.id, ok: false, words: 'The setup changed. Press Start again.' });
  }
  return out;
}

const fresh = (s: LcState) => !!s.run && !s.run.refreshOwed && s.run.published !== undefined && s.run.changes === s.run.published;

/** The invariants (LIFECYCLE-machine.md 5), on one transition. */
function check(prev: LcState, e: LcEvent, s: LcState, effects: readonly LcEffect[]): string[] {
  const bad: string[] = [];
  const run = s.run;
  // I1: Ready entered only fresh and Idle; callable only then.
  if (run?.step === 'ready' && prev.run?.step !== 'ready' && (s.slot !== 'idle' || !fresh(s))) bad.push('I1: Ready entered stale or busy');
  // And the catalog it stands on was walked under every notice read: the walk's own count, not the record.
  if (run?.step === 'ready' && prev.run?.step !== 'ready' && prev.run?.walk && prev.run.walk.startedAt !== run.changes) bad.push('I1: Ready on a walk a notice outran');
  if (callable(s) && (s.slot !== 'idle' || !fresh(s))) bad.push('I1: callable on a stale catalog or a busy slot');
  // I2: one process per setup; one native stop per run.
  const alive = s.orphans.length + (run?.native && (run.native.start === 'pending' || (run.native.process && !run.native.exited)) ? 1 : 0);
  if (alive > 1) bad.push(`I2: ${alive} processes for one setup`);
  const stops = effects.filter((x) => x.t === 'native-stop');
  if (stops.length > 1) bad.push('I2: two native stops in one step');
  for (const x of stops) if (x.t === 'native-stop' && prev.run?.id === x.run && prev.run.native && prev.run.native.stop !== 'none') bad.push('I2: a second native stop for a run');
  if (effects.some((x) => x.t === 'native-start') && alive > 1) bad.push('I2: a start beside a live process');
  // I3: each waiter answered once, truthfully.
  const answers = effects.filter((x): x is Extract<LcEffect, { t: 'answer' }> => x.t === 'answer');
  const tokens = new Set<string>();
  for (const a of answers) {
    if (tokens.has(a.token)) bad.push(`I3: ${a.token} answered twice`);
    tokens.add(a.token);
    const w = prev.waiters.find((x) => x.token === a.token);
    const fromEvent = e.t === 'start' || e.t === 'stop' ? e.token === a.token : false;
    if (!w && !fromEvent) bad.push(`I3: ${a.token} answered, never waiting`);
    if (s.waiters.some((x) => x.token === a.token)) bad.push(`I3: ${a.token} answered and still waiting`);
    const kind = w?.kind ?? (e.t === 'stop' ? 'stop' : 'start');
    if (a.reply.kind === 'stopped' && kind === 'stop') {
      // "stopped": a remote run, no process ever, or this run's exit seen in this very event.
      const pr = prev.run;
      const local = pr?.where === 'local' && pr.native?.process && pr.id === w?.run;
      if (local && !(e.t === 'exit' && e.process === pr!.native!.process)) bad.push('I3: Stop answered stopped before its exit');
    }
    // Ready answered only while the server is Ready (a refresh a notice started during the start's own
    // catalog write is the named window: still Ready, its calls refused until it lands).
    if (a.reply.kind === 'ready' && phaseOf(s) !== 'ready') bad.push('I3: ready answered off Ready');
    if (a.reply.kind === 'tested' && !(e.t === 'exit' || prev.run?.where === 'remote' || e.t === 'started')) bad.push('I3: Test answered ok before its run ended');
    // A start or Test answered "stopped" only for the person's own Stop: any other cause has its own words.
    if (a.reply.kind === 'stopped' && kind !== 'stop' && !(e.t === 'stop' || prev.run?.cause === 'person-stop')) bad.push(`I3: a start answered stopped for a run ended by ${prev.run?.cause ?? e.t}`);
    // "stopped" is never true while a process may still run.
    if (a.reply.kind === 'stopped' && s.orphans.length) bad.push('I3: stopped answered while a process may still run');
  }
  // I4: an event from a run that isn't current changes nothing (an orphan's exit only drops that orphan).
  const runOf = (x: LcEvent) => ('run' in x ? (x as { run: string }).run : undefined);
  const r = runOf(e);
  if (r !== undefined && r !== prev.run?.id && canonical(prev) !== canonical(s)) bad.push(`I4: an old run's ${e.t} changed the state`);
  if (e.t === 'deadline' && e.id !== prev.run?.deadline?.id && e.id !== prev.run?.saveBy && canonical(prev) !== canonical(s)) bad.push('I4: a stale deadline changed the state');
  // I5: every waiter has a deadline that will answer it.
  for (const w of s.waiters) {
    const bound = w.kind !== 'stop' && run?.saveBy !== undefined ? true : !!run?.deadline;
    if (!bound && !s.held) bad.push(`I5: a ${w.kind} waiter with no deadline armed`);
  }
  // I6: the owner held exactly while a native start is pending.
  const pending = run?.native?.start === 'pending';
  if ((s.owner === 'start') !== !!pending) bad.push(`I6: owner ${s.owner} with the native start ${run?.native?.start ?? 'none'}`);
  // I7: a relaunch only after an unanswered list, never after Familiar ended the run.
  if (effects.some((x) => x.t === 'readmit-check') && prev.run && (prev.run.killed || prev.run.walk?.answered)) bad.push('I7: a relaunch after a Familiar-caused end or an answered list');
  // I8, I9: a deadline that fires answers the waiters it bounds.
  if (e.t === 'deadline' && e.id === prev.run?.deadline?.id) {
    const which = prev.run.deadline.which;
    const bounded = prev.waiters.filter((w) => (which === 'stop' ? w.kind === 'stop' : which === 'start' ? w.kind !== 'stop' : true) && w.run === prev.run!.id);
    // Answered, or handed to a stop now under way with its own deadline (Test's own stop, say), which a
    // stop deadline itself can never do.
    const handed = which !== 'stop' && s.run?.step === 'closing' && s.run.deadline?.which === 'stop';
    for (const w of bounded) if (s.waiters.some((x) => x.token === w.token) && !handed) bad.push(`I8/I9: ${w.kind} ${w.token} still waiting after its ${which} deadline`);
  }
  // I10: nothing admitted after the fence; a recovery never changes the era.
  for (const x of effects) if (x.t === 'admin' && (run?.step === 'closing' || run?.id !== x.run)) bad.push('I10: an admin exchange for a closing or ended run');
  if (prev.run && run && prev.run.id === run.id && prev.run.purpose === 'recovery' && prev.run.era !== run.era) bad.push('I10: a recovery changed the era');
  // I11: one catalog save at a time, each for the newest catalog.
  const saves = effects.filter((x) => x.t === 'save');
  if (saves.length && prev.saving && e.t !== 'saved') bad.push('I11: a save while another is in flight');
  for (const x of saves) if (x.t === 'save' && run && x.gen !== run.gen) bad.push('I11: a save of an older catalog');
  // I12: Ready with unwalked notices always owes or runs a refresh.
  if (run && run.step === 'ready' && run.published !== undefined && run.changes !== run.published && !run.refreshOwed) bad.push('I12: Ready stranded on a stale catalog');
  // The phase is always one of the six.
  if (!['stopped', 'starting', 'ready', 'stopping', 'failed', 'held'].includes(phaseOf(s))) bad.push('phase unknown');
  return bad;
}

interface WalkResult {
  states: number;
  transitions: number;
  depth: number;
  ms: number;
  violation?: { trace: LcEvent[]; problems: string[] };
}

/** Breadth first over (state, ctx), exactly deduplicated by canonical form. */
function walk(where: Where, maxDepth: number, stopAtFirst = true): WalkResult {
  const t0 = performance.now();
  const start = initialState('s');
  const seen = new Set<string>([canonical([start, CTX0])]);
  let frontier: { s: LcState; c: Ctx; trace: LcEvent[] }[] = [{ s: start, c: CTX0, trace: [] }];
  let transitions = 0;
  let depth = 0;
  for (; depth < maxDepth && frontier.length; depth++) {
    const nextFrontier: typeof frontier = [];
    for (const { s, c, trace } of frontier) {
      for (const [e, c2] of alphabet(s, c, where)) {
        transitions++;
        const out = next(s, e);
        const problems = check(s, e, out.state, out.effects);
        if (problems.length) {
          const result = { states: seen.size, transitions, depth: depth + 1, ms: performance.now() - t0, violation: { trace: [...trace, e], problems } };
          if (stopAtFirst) return result;
        }
        const key = canonical([out.state, c2]);
        if (seen.has(key)) continue;
        seen.add(key);
        nextFrontier.push({ s: out.state, c: c2, trace: [...trace, e] });
      }
    }
    frontier = nextFrontier;
  }
  return { states: seen.size, transitions, depth, ms: performance.now() - t0 };
}

/** The same walk with no deduplication, counting the distinct states it reaches (the cross-check). */
function fullCount(where: Where, maxDepth: number): number {
  const distinct = new Set<string>();
  const go = (s: LcState, c: Ctx, d: number) => {
    distinct.add(canonical([s, c]));
    if (d === maxDepth) return;
    for (const [e, c2] of alphabet(s, c, where)) go(next(s, e).state, c2, d + 1);
  };
  go(initialState('s'), CTX0, 0);
  return distinct.size;
}

/** Replays a trace on the machine as it is, and returns any invariant it breaks. */
function replay(trace: readonly LcEvent[]): string[] {
  let s = initialState('s');
  const out: string[] = [];
  for (const e of trace) {
    const r = next(s, e);
    out.push(...check(s, e, r.state, r.effects));
    s = r.state;
  }
  return out;
}

// CI walks to depth 11; locally FAMILIAR_LC_DEPTH=13 (about 2 minutes for the local clean walk).
const DEPTH = Number(process.env.FAMILIAR_LC_DEPTH ?? 11);

describe('W for the run lifecycle', () => {
  for (const where of ['local', 'remote'] as const) {
    it(`holds I1 to I12 over every trace to depth ${DEPTH}, ${where}`, () => {
      const r = walk(where, DEPTH);
      if (process.env.FAMILIAR_VERBOSE) console.log(`LC-W ${where}: ${r.states} states, ${r.transitions} transitions, depth ${r.depth}, ${Math.round(r.ms)} ms`);
      expect(r.violation, r.violation ? `${r.violation.problems.join('; ')} after ${r.violation.trace.map((e) => e.t + ('outcome' in e ? `:${(e as any).outcome.k}` : '') + ('ok' in e ? `:${(e as any).ok}` : '')).join(' > ')}` : '').toBeUndefined();
      expect(r.states).toBeGreaterThan(1000);
    }, 600_000);

    it(`dedupes exactly: the deduplicated count equals a full walker's at a small bound, ${where}`, () => {
      const d = 6;
      const r = walk(where, d, false);
      expect(r.states).toBe(fullCount(where, d));
    }, 600_000);
  }

  // Each guard the machine keeps for a finding, broken: W finds a violating trace, and that trace passes
  // on the unmutated machine.
  const CONTROLS: { mutation: string; where: Where; finding: string }[] = [
    { mutation: 'lc-ready-before-idle', where: 'local', finding: 'the start/drain race' },
    { mutation: 'lc-ready-stale', where: 'local', finding: 'r33 #2: a notice during the final drain' },
    { mutation: 'lc-refresh-dropped', where: 'local', finding: 'F02: the refresh lost to an idle ping' },
    { mutation: 'lc-relaunch-after-kill', where: 'local', finding: 'r32 #2: a relaunch after the watchdog' },
    { mutation: 'lc-relaunch-on-answer', where: 'local', finding: 'r32 #3, r33 #3: a relaunch after an answered list' },
    { mutation: 'lc-stopped-on-refusal', where: 'local', finding: 'F28, r32b #7: stopped claimed after a refusal' },
    { mutation: 'lc-second-stop-stopped', where: 'local', finding: 'r33 #4: a second Stop says stopped' },
    { mutation: 'lc-test-ok-on-refusal', where: 'local', finding: 'r33b #6: Test ok after a refused stop' },
    { mutation: 'lc-owner-held-on-stop', where: 'local', finding: 'r33b #5: the owner held after the start answered' },
    { mutation: 'lc-no-stop-deadline', where: 'local', finding: 'I8: a Stop that can hang' },
    { mutation: 'lc-two-native-stops', where: 'local', finding: 'r31b #9: two native stops for one run' },
    { mutation: 'lc-old-run-events', where: 'local', finding: 'r30b #3: an old run acting on the current one' },
    { mutation: 'lc-readmit-after-stop', where: 'local', finding: 'a readmit that launches after Stop cancelled it' },
    { mutation: 'lc-start-beside-orphan', where: 'local', finding: 'I2: a Start beside a process that may still run' },
    { mutation: 'lc-save-overlap', where: 'local', finding: 'I11: two catalog saves in flight' },
    { mutation: 'lc-admit-after-fence', where: 'local', finding: 'r30b #4: an exchange admitted after Stop' },
    { mutation: 'lc-era-on-recovery', where: 'remote', finding: 'r30 #5: a recovery changing the era' },
    { mutation: 'lc-crash-words-lost', where: 'local', finding: 'F05: a start answered stopped after a crash' }
  ];
  for (const c of CONTROLS) {
    it(`${c.mutation} is caught (${c.finding}), and its trace passes unmutated`, () => {
      mutations.set([c.mutation]);
      let r: WalkResult;
      try {
        r = walk(c.where, DEPTH);
      } finally {
        mutations.clear();
      }
      expect(r.violation, `${c.mutation}: no violating trace to depth ${DEPTH}`).toBeDefined();
      expect(replay(r.violation!.trace), 'the twin').toEqual([]);
    }, 600_000);
  }
});
