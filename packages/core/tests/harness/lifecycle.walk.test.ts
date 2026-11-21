// W for the run lifecycle (docs/mcp-design.md 5.4; the machine in src/mcp/wire/lifecycle.ts): an exhaustive
// walk over the pure `next()` with the whole event alphabet at every point, bounded by depth and by small
// counts of each kind of event, checking the invariants at every reached state and on every transition.
// States are deduplicated exactly, by their canonical form (never by a hash alone), and at a small bound the
// count is cross-checked against a walker that doesn't deduplicate. Each guard the machine has for a finding
// has a named mutation; under it the walk must find a violating trace, and the same trace must pass on the
// unmutated machine.
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
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
const READMIT_OK = { ownerFree: true, enabled: true, launch: '' };

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
    add({ t: 'readmit', run: `${s.id}#0`, facts: READMIT_OK }, { stale: 1 });
  }
  if (s.zombie) add({ t: 'readmit', run: s.zombie, facts: READMIT_OK });
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
    // The relaunch's facts read now: all well; the owner busy; the setup changed; turned off.
    add({ t: 'readmit', run: run.id, facts: { ...READMIT_OK, launch: run.launch } });
    add({ t: 'readmit', run: run.id, facts: { ...READMIT_OK, launch: run.launch, ownerFree: false, ownerWords: 'Saving another change.' } });
    add({ t: 'readmit', run: run.id, facts: { ...READMIT_OK, launch: `${run.launch}+` } });
    add({ t: 'readmit', run: run.id, facts: { ...READMIT_OK, launch: run.launch, enabled: false } });
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
  /** Whether the frontier emptied: every reachable state was expanded (the fixpoint). */
  done: boolean;
  frontier: number;
  peakHeapMb: number;
  violation?: { trace: LcEvent[]; problems: string[] };
}

/** Where a walk begins: the initial state, or a checkpoint a scripted trace reached through `next()`, with
    the ctx that trace used up. */
interface Origin {
  readonly name: string;
  readonly s: LcState;
  readonly c: Ctx;
  readonly trace: readonly LcEvent[];
}
const ORIGIN0 = (): Origin => ({ name: 'initial', s: initialState('s'), c: CTX0, trace: [] });

/** A trace's events, kept as a chain to its parent: the frontier holds no copies of whole traces. */
interface Step {
  readonly e: LcEvent;
  readonly up: Step | undefined;
}
const traceOf = (origin: Origin, step: Step | undefined): LcEvent[] => {
  const out: LcEvent[] = [];
  for (let x = step; x; x = x.up) out.push(x.e);
  return [...origin.trace, ...out.reverse()];
};

/**
 * The (state, ctx) pair with its names renumbered: tokens, run ids, processes and deadline ids by their order
 * of first appearance in the canonical traversal (from 1, so the stale events' reserved `#0`, `p0` and
 * deadline 0 stay apart), catalog generations and the marks naming them by rank (the machine compares them by order), and the
 * counters that only mint fresh names dropped. Two pairs alike up to such renaming have alike futures: the
 * machine and the alphabet compare these names only for equality (generations for order), and mint fresh
 * ones above all present.
 */
function renumbered(s: LcState, c: Ctx): string {
  const gens = new Set<number>([0]);
  const seeGen = (v: unknown, k?: string): void => {
    if (v === null || typeof v !== 'object') {
      if (k !== undefined && GEN_KEYS.has(k) && typeof v === 'number') gens.add(v);
      return;
    }
    for (const kk in v as Record<string, unknown>) seeGen((v as Record<string, unknown>)[kk], kk);
  };
  seeGen(s);
  const rank = new Map([...gens].sort((a, b) => a - b).map((g, i) => [g, i]));
  const names = new Map<string, string>();
  const counts: Record<string, number> = {};
  const rename = (kind: string, v: string | number): string => {
    const key = `${kind}:${v}`;
    let out = names.get(key);
    if (out === undefined) names.set(key, (out = `${kind}${(counts[kind] = (counts[kind] ?? 0) + 1)}`));
    return out;
  };
  // One pass, in the canonical form's own order (keys sorted, undefined dropped), renaming as it goes.
  const str = (v: unknown, k?: string): string => {
    if (typeof v === 'string') {
      if (/^k\d+$/.test(v)) return JSON.stringify(rename('k', v));
      if (/^.+#\d+$/.test(v)) return JSON.stringify(rename('r', v));
      if (/^p\d+$/.test(v)) return JSON.stringify(rename('p', v));
      return JSON.stringify(v);
    }
    if (typeof v === 'number') {
      if (k !== undefined && GEN_KEYS.has(k)) return String(rank.get(v));
      if (k === 'saveBy' || k === 'deadline-id') return JSON.stringify(rename('d', v));
      return String(v);
    }
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
    if (Array.isArray(v)) return `[${v.map((x) => str(x)).join(',')}]`;
    const o = v as Record<string, unknown>;
    // A deadline's id is a name; its kind isn't.
    const isDeadline = 'which' in o && typeof o.id === 'number';
    const parts: string[] = [];
    for (const kk of Object.keys(o).sort()) {
      if (o[kk] === undefined || (k === undefined && DROPPED.has(kk))) continue;
      parts.push(`${JSON.stringify(kk)}:${str(o[kk], isDeadline && kk === 'id' ? 'deadline-id' : kk)}`);
    }
    return `{${parts.join(',')}}`;
  };
  return `[${str(s)},${str(c)}]`;
}
/** The fields that hold a catalog generation, ranked together: the machine compares the marks (a later
    write retried or marked unsaved, the newest written) with the generations. */
const GEN_KEYS = new Set(['gen', 'firstGen', 'retried', 'unsaved', 'written']);
/** The counters that only mint fresh names, dropped from the renumbered form (top level only). */
const DROPPED = new Set(['nextRun', 'nextDeadline', 'nextGen', 'tokens']);

/** The walk's key for a state: its canonical form exactly, or (`digest`) that form's SHA-256, 32 bytes. */
const keyOf = (v: unknown, digest: boolean): string => {
  const text = typeof v === 'string' ? v : canonical(v);
  return digest ? createHash('sha256').update(text).digest().toString('latin1') : text;
};

/**
 * Breadth first over (state, ctx), exactly deduplicated: by canonical form, or by its SHA-256 for the
 * unbounded walk (exact for our purpose: a collision is beyond reach). `maxDepth` Infinity walks to the
 * fixpoint, unless `budgetMs` runs out first.
 */
function walk(where: Where, maxDepth: number, stopAtFirst = true, origin: Origin = ORIGIN0(), opts: { digest?: boolean; renumber?: boolean; budgetMs?: number; progress?: (r: WalkResult) => void } = {}): WalkResult {
  const t0 = performance.now();
  const digest = !!opts.digest;
  const form = (st: LcState, c: Ctx): unknown => (opts.renumber ? renumbered(st, c) : [st, c]);
  const seen = new Set<string>([keyOf(form(origin.s, origin.c), digest)]);
  let frontier: { s: LcState; c: Ctx; step: Step | undefined }[] = [{ s: origin.s, c: origin.c, step: undefined }];
  let transitions = 0;
  let depth = 0;
  let peak = 0;
  const result = (extra: Partial<WalkResult> = {}): WalkResult => ({ states: seen.size, transitions, depth, ms: performance.now() - t0, done: frontier.length === 0, frontier: frontier.length, peakHeapMb: Math.round(peak / 2 ** 20), ...extra });
  for (; depth < maxDepth && frontier.length; depth++) {
    if (opts.budgetMs !== undefined && performance.now() - t0 > opts.budgetMs) return result();
    const nextFrontier: typeof frontier = [];
    for (const { s, c, step } of frontier) {
      for (const [e, c2] of alphabet(s, c, where)) {
        transitions++;
        const out = next(s, e);
        const problems = check(s, e, out.state, out.effects);
        if (problems.length) {
          const found = result({ depth: depth + 1, violation: { trace: traceOf(origin, { e, up: step }), problems } });
          if (stopAtFirst) return found;
        }
        const key = keyOf(form(out.state, c2), digest);
        if (seen.has(key)) continue;
        seen.add(key);
        nextFrontier.push({ s: out.state, c: c2, step: { e, up: step } });
      }
    }
    frontier = nextFrontier;
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    opts.progress?.(result({ depth: depth + 1 }));
  }
  return result();
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

/* ---------- checkpoints: named states scripted traces reach through next() ---------- */

type Pick = (e: LcEvent) => boolean;
const is =
  (t: LcEvent['t'], more: (e: any) => boolean = () => true): Pick =>
  (e) =>
    e.t === t && more(e);

/** Drives `next()` from `from` by the alphabet's own events, the first that each pick matches, and names
    where it lands; the ctx is the alphabet's, so the checkpoint's walk has what the trace left of each bound. */
function drive(where: Where, name: string, picks: readonly Pick[], from: Origin = ORIGIN0()): Origin {
  let { s, c } = from;
  const trace = [...from.trace];
  for (const [i, p] of picks.entries()) {
    // The current run's events only: the alphabet's stale ones (an earlier run's) are never a checkpoint's.
    // An exchange that has ended frees the slot first, as the exchange machine's own Idle would.
    const find = () => alphabet(s, c, where).find(([e]) => (!('run' in e) || e.run === s.run?.id) && p(e));
    let found = find();
    if (!found && s.slot === 'busy' && !s.run?.inFlight) {
      const out = next(s, { t: 'slot', idle: true });
      trace.push({ t: 'slot', idle: true });
      s = out.state;
      found = find();
    }
    if (!found) throw new Error(`checkpoint ${name}: pick ${i} matches no event in ${s.run?.step ?? phaseOf(s)}`);
    const [e, c2] = found;
    const out = next(s, e);
    const bad = check(s, e, out.state, out.effects);
    if (bad.length) throw new Error(`checkpoint ${name}: ${bad.join('; ')}`);
    trace.push(e);
    s = out.state;
    c = c2;
  }
  return { name, s, c, trace };
}

const page = (more: boolean) => is('admin-done', (e) => e.outcome.k === 'page' && e.outcome.more === more && (more || e.outcome.catalog === 'ok'));
const startOk = is('start', (e) => e.mode === 'start' && e.facts.ownerFree);
const idle = is('slot', (e) => e.idle);

/** The named checkpoints, each with what it must be. */
function checkpoints(): { origin: Origin; where: Where; holds: (s: LcState) => boolean }[] {
  const saving = drive('local', 'local Ready, its save in flight', [startOk, is('started', (e) => e.ok), is('admin-done', (e) => e.outcome.k === 'legacy'), is('admin-done', (e) => e.outcome.k === 'ok'), page(false), idle]);
  const ready = drive('local', 'local Ready', [is('saved', (e) => e.outcome === 'saved')], saving);
  const refreshing = drive('local', 'refreshing', [is('notice')], ready);
  const orphan = drive('local', 'closing after a refused stop, the orphan open', [is('stop'), is('stop-answered', (e) => !e.ok)], ready);
  const run2 = drive('local', "run 2 launching after run 1's orphan exited", [(e: LcEvent) => e.t === 'exit' && orphan.s.orphans.some((o) => o.process === (e as any).process), startOk], orphan);
  const relaunch = drive('local', 'relaunch pending', [startOk, is('started', (e) => e.ok), is('admin-done', (e) => e.outcome.k === 'modern-refusal'), is('admin-done', (e) => e.outcome.k === 'unanswered'), is('exit')]);
  const rsaving = drive('remote', 'remote Ready, its save in flight', [startOk, is('admin-done', (e) => e.outcome.k === 'legacy'), is('admin-done', (e) => e.outcome.k === 'ok'), page(false), idle], { ...ORIGIN0() });
  const rready = drive('remote', 'remote Ready', [is('saved', (e) => e.outcome === 'saved')], rsaving);
  const recovering = drive('remote', 'remote recovering', [is('call-ended', (e) => e.end === 'session-ended')], rready);
  return [
    { origin: ready, where: 'local', holds: (s) => phaseOf(s) === 'ready' && !s.saving && callable(s) },
    { origin: saving, where: 'local', holds: (s) => s.run?.step === 'ready' && !!s.saving },
    { origin: refreshing, where: 'local', holds: (s) => !!s.run && s.run.purpose === 'refresh' && s.run.step !== 'ready' },
    { origin: orphan, where: 'local', holds: (s) => s.orphans.length === 1 && !s.run },
    { origin: relaunch, where: 'local', holds: (s) => s.run?.step === 'relaunch' },
    { origin: run2, where: 'local', holds: (s) => s.run?.step === 'launching' && s.orphans.length === 0 && s.run.id !== ready.s.run?.id },
    { origin: rready, where: 'remote', holds: (s) => phaseOf(s) === 'ready' && !s.saving && callable(s) },
    { origin: recovering, where: 'remote', holds: (s) => s.run?.purpose === 'recovery' }
  ];
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

  // The fixpoint, run locally as the close's evidence (FAMILIAR_LC_FIXPOINT=1): the same walk with no depth
  // bound, keyed by the SHA-256 of the renumbered form, until the frontier is empty or about 30 minutes pass
  // (FAMILIAR_LC_FIXPOINT=exact keys the plain canonical form; it doesn't finish in that time). Progress goes
  // to FAMILIAR_LC_LOG. At 7254177: local, the fixpoint at depth 35, 2,038,928 states, 18,389,550 transitions, 554 s;
  // remote at depth 42, 301,598 states, 3,176,914 transitions, 79 s. (At 22e6800: local depth 41, 2,681,234; remote
  // depth 48, 411,602. Remote was 691,192 at depth 53 by 8bc698a; 6b.13's retry marks took it to 882,502 at depth 55;
  // writing each generation once, 782,230 at depth 56 (local 3,772,366 at depth 45); the queue going with its run,
  // 481,652 at depth 48 (local 2,290,292 at depth 36); and each write's identity fixed when issued, 301,598, since
  // the queue now lives on its run and states no longer split on a queue flag that can no longer fire.)
  const fixpointLog = (line: string) => {
    if (process.env.FAMILIAR_LC_LOG) appendFileSync(process.env.FAMILIAR_LC_LOG, `${new Date().toISOString()} ${line}\n`);
  };
  const fmt = (label: string, r: WalkResult) => `${label}: ${r.done ? 'fixpoint' : 'STOPPED'} at depth ${r.depth}, ${r.states} states, ${r.transitions} transitions, frontier ${r.frontier}, ${Math.round(r.ms / 1000)} s, peak heap ${r.peakHeapMb} MB${r.violation ? `, VIOLATION ${r.violation.problems.join('; ')}` : ''}`;
  for (const where of ['local', 'remote'] as const)
    it.skipIf(!process.env.FAMILIAR_LC_FIXPOINT)(`holds I1 to I12 to the fixpoint, ${where}`, () => {
      const renumber = process.env.FAMILIAR_LC_FIXPOINT !== 'exact';
      const r = walk(where, Infinity, true, ORIGIN0(), { digest: true, renumber, budgetMs: 30 * 60_000, progress: (p) => fixpointLog(fmt(`progress ${where}${renumber ? ' renumbered' : ''}`, p)) });
      fixpointLog(fmt(`FIXPOINT ${where}${renumber ? ' renumbered' : ''}`, r));
      expect(r.violation, r.violation?.problems.join('; ')).toBeUndefined();
      expect(r.done, `stopped at depth ${r.depth} with ${r.frontier} in the frontier`).toBe(true);
    }, 40 * 60_000);

  // The renumbered key (the fixpoint's) merges only pairs alike up to names: for every pair it merges in an
  // exact walk to depth 7, both have the same successors (by renumbered key) and the same verdicts.
  for (const where of ['local', 'remote'] as const)
    it(`renumbering merges only states with alike futures, one step on, to depth 7, ${where}`, () => {
      const exact = new Set<string>();
      const reps = new Map<string, { s: LcState; c: Ctx }>();
      const succ = (st: LcState, c: Ctx) =>
        alphabet(st, c, where)
          .map(([e, c2]) => {
            const out = next(st, e);
            return `${renumbered(out.state, c2)}|${check(st, e, out.state, out.effects).length}`;
          })
          .sort()
          .join('\n');
      let merged = 0;
      let frontier: { s: LcState; c: Ctx }[] = [{ s: initialState('s'), c: CTX0 }];
      for (let d = 0; d < 7; d++) {
        const nf: typeof frontier = [];
        for (const { s: st, c } of frontier)
          for (const [e, c2] of alphabet(st, c, where)) {
            const s2 = next(st, e).state;
            const k = canonical([s2, c2]);
            if (exact.has(k)) continue;
            exact.add(k);
            nf.push({ s: s2, c: c2 });
            const rk = renumbered(s2, c2);
            const rep = reps.get(rk);
            if (!rep) reps.set(rk, { s: s2, c: c2 });
            else {
              merged++;
              expect(succ(s2, c2), `merged unlike states: ${k.slice(0, 200)}`).toBe(succ(rep.s, rep.c));
            }
          }
        frontier = nf;
      }
      if (process.env.FAMILIAR_VERBOSE) console.log(`LC-W renumbering ${where}: ${exact.size} exact states to depth 7, ${reps.size} renumbered, ${merged} merged pairs checked`);
      expect(merged).toBeGreaterThan(0);
    }, 600_000);

  // A mark that names a generation (a later write retried, or marked unsaved) is ranked with the generations:
  // the machine compares it with them. A later save's failure is about 13 events in, past the merge check's
  // depth, so the key is checked here directly: a reached state, its generations all renamed (alike, one key),
  // and the same with only the generations renamed and the mark left (unlike: a failure then retries in one
  // and marks unsaved in the other).
  it('renumbering ranks the generation marks with the generations', () => {
    let s = initialState('s');
    const feed = (e: LcEvent | ((s: LcState) => LcEvent)) => (s = next(s, typeof e === 'function' ? e(s) : e).state);
    const cur = (f: (id: string) => LcEvent) => (st: LcState) => f(st.run!.id);
    feed({ t: 'start', token: 'k1', mode: 'start', facts: { record: 'ok', ownerFree: true, where: 'local' } });
    feed(cur((id) => ({ t: 'started', run: id, ok: true, process: 'p1' })));
    feed(cur((id) => ({ t: 'admin-done', run: id, outcome: { k: 'legacy' } })));
    feed({ t: 'slot', idle: true });
    feed(cur((id) => ({ t: 'admin-done', run: id, outcome: { k: 'ok' } })));
    feed({ t: 'slot', idle: true });
    feed(cur((id) => ({ t: 'admin-done', run: id, outcome: { k: 'page', more: false, catalog: 'ok' } })));
    feed({ t: 'slot', idle: true });
    feed((st) => ({ t: 'saved', gen: st.saving!.gen, outcome: 'saved' }));
    feed(cur((id) => ({ t: 'notice', run: id })));
    feed(cur((id) => ({ t: 'admin-done', run: id, outcome: { k: 'page', more: false, catalog: 'ok' } })));
    feed({ t: 'slot', idle: true });
    feed((st) => ({ t: 'saved', gen: st.saving!.gen, outcome: 'failed' }));
    const x = s;
    const mark = x.run!.retried ?? x.run!.unsaved;
    expect(mark).toBe(x.run!.gen);
    const shift = (st: LcState, marks: boolean, written = true): LcState => {
      const r = st.run!;
      return { ...st, nextGen: st.nextGen + 5, saving: st.saving && { ...st.saving, gen: st.saving.gen + 5 }, run: { ...r, gen: r.gen + 5, firstGen: r.firstGen + 5, ...(marks && r.retried !== undefined ? { retried: r.retried + 5 } : {}), ...(marks && r.unsaved !== undefined ? { unsaved: r.unsaved + 5 } : {}), ...(written && r.written !== undefined ? { written: r.written + 5 } : {}) } };
    };
    const alike = shift(x, true);
    const unlike = shift(x, false);
    const fail = (st: LcState) => next(st, { t: 'saved', gen: st.saving!.gen, outcome: 'failed' });
    // The unlike pair's futures differ: the alike one marks unsaved, as x does; the unlike one retries.
    expect(fail(alike).effects).toEqual(fail(x).effects);
    expect(fail(unlike).effects).not.toEqual(fail(x).effects);
    expect(renumbered(alike, CTX0)).toBe(renumbered(x, CTX0));
    expect(renumbered(unlike, CTX0)).not.toBe(renumbered(x, CTX0));
    // The newest written generation is a mark too: left behind, the key changes.
    expect(x.run!.written).toBe(x.run!.gen);
    expect(renumbered(shift(x, true, false), CTX0)).not.toBe(renumbered(x, CTX0));
  });

  it('reaches each named checkpoint through next(), each the state it names', () => {
    for (const k of checkpoints()) expect(k.holds(k.origin.s), k.origin.name).toBe(true);
  });

  // From each checkpoint, the same walk to the same depth, with the ctx its trace used up: what happens
  // after Ready (a refresh then a Stop, a recovery then a Stop, a notice during the save then a refused
  // stop) is walked as deep as the start is from the initial state.
  for (const k of checkpoints())
    it(`holds I1 to I12 over every trace to depth ${DEPTH} from ${k.origin.name}`, () => {
      const r = walk(k.where, DEPTH, true, k.origin);
      if (process.env.FAMILIAR_VERBOSE) console.log(`LC-W ${k.origin.name}: ${r.states} states, ${r.transitions} transitions, depth ${r.depth}, ${Math.round(r.ms)} ms`);
      expect(r.violation, r.violation ? `${r.violation.problems.join('; ')} after ${r.violation.trace.map((e) => e.t).join(' > ')}` : '').toBeUndefined();
    }, 600_000);

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
  // Where each control is caught: the initial state, or the named checkpoint (FAMILIAR_LC_CAUGHT=1 prints,
  // for each control, every origin whose depth-8 walk catches it).
  // The survey (depth 8) found each from these, among others; four are caught from no state but a
  // checkpoint at that depth (lc-ready-stale, lc-refresh-dropped, lc-save-overlap, lc-era-on-recovery).
  const CAUGHT_FROM: Record<string, string> = {
    'lc-ready-before-idle': 'refreshing',
    'lc-ready-stale': 'refreshing',
    'lc-refresh-dropped': 'local Ready',
    'lc-relaunch-after-kill': "run 2 launching after run 1's orphan exited",
    'lc-relaunch-on-answer': "run 2 launching after run 1's orphan exited",
    'lc-stopped-on-refusal': 'local Ready',
    'lc-second-stop-stopped': 'closing after a refused stop, the orphan open',
    'lc-test-ok-on-refusal': 'initial',
    'lc-owner-held-on-stop': "run 2 launching after run 1's orphan exited",
    'lc-no-stop-deadline': 'local Ready',
    'lc-two-native-stops': 'local Ready',
    'lc-old-run-events': "run 2 launching after run 1's orphan exited",
    'lc-readmit-after-stop': 'relaunch pending',
    'lc-start-beside-orphan': 'closing after a refused stop, the orphan open',
    'lc-save-overlap': 'local Ready, its save in flight',
    'lc-admit-after-fence': 'refreshing',
    'lc-era-on-recovery': 'remote recovering',
    'lc-crash-words-lost': 'local Ready, its save in flight'
  };
  for (const c of CONTROLS) {
    it(`${c.mutation} is caught (${c.finding}) from ${CAUGHT_FROM[c.mutation] ?? 'initial'}, and its trace passes unmutated`, () => {
      const name = CAUGHT_FROM[c.mutation] ?? 'initial';
      const origin = name === 'initial' ? ORIGIN0() : checkpoints().find((k) => k.origin.name === name)!.origin;
      mutations.set([c.mutation]);
      let r: WalkResult;
      try {
        r = walk(c.where, DEPTH, true, origin);
      } finally {
        mutations.clear();
      }
      expect(r.violation, `${c.mutation}: no violating trace to depth ${DEPTH}`).toBeDefined();
      expect(replay(r.violation!.trace), 'the twin').toEqual([]);
    }, 600_000);
  }

  it.skipIf(!process.env.FAMILIAR_LC_CAUGHT)('which origins catch each control, at depth 8', () => {
    const origins = [{ origin: ORIGIN0(), where: undefined as Where | undefined }, ...checkpoints().map((k) => ({ origin: k.origin, where: k.where as Where | undefined }))];
    for (const c of CONTROLS) {
      const by: string[] = [];
      for (const o of origins) {
        if (o.where && o.where !== c.where) continue;
        mutations.set([c.mutation]);
        let r: WalkResult;
        try {
          r = walk(c.where, 8, true, o.origin);
        } finally {
          mutations.clear();
        }
        if (r.violation && !replay(r.violation.trace).length) by.push(`${o.origin.name} (${r.violation.trace.length - o.origin.trace.length})`);
      }
      fixpointLog(`CAUGHT ${c.mutation}: ${by.join(' | ') || 'none at depth 8'}`);
    }
  }, 3_600_000);
});
