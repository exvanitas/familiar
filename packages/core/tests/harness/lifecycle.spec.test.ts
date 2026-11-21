// W with the independent checks (pass 5, Track O): oracle5 wrote lifecycle.spec-checks.ts from the spec
// alone (LIFECYCLE-machine.md, design 5.4 and section 6, and the machine's types as they stood at 78d2a46,
// lifecycle.spec-types.ts), never reading the machine's code. It is kept in its own words. This file runs
// its controls, and walks the machine with its alphabet and its checks beside W's own (lifecycle.walk.test.ts):
// from the initial state at CI depth, from the named checkpoints, and (FAMILIAR_LC_SPEC_FIXPOINT=1, locally)
// to the fixpoint.
//
// The one adapter: the readmit event. At 78d2a46 the driver decided the relaunch and fed `{ ok, words, off }`;
// now the machine decides it from the facts read when it is due (`{ facts: { ownerFree, enabled, launch } }`).
// Each spec readmit maps to the facts that give it: ok (all well), the owner busy, or turned off (enabled
// false), for whatever run it names. The checks see the spec's event. The adapter filters nothing: every
// event of the spec's alphabet is given to the machine as it is.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { callable, failureOf, initialState, next, offering, phaseOf, type LcEffect, type LcEvent, type LcState } from '../../src/mcp/wire/lifecycle.ts';
import { mutations } from '../../src/mutations.ts';
import type * as Spec from './lifecycle.spec-types.ts';
import { advance, alphabet, canon, checkState, checkTransition, CLAUSES, CONTROLS, CTX0, histFromState, initialHistory, stubMachine, type Control, type Ctx, type History, type Machine } from './lifecycle.spec-checks.ts';

type Where = 'local' | 'remote';

/* ---------- the controls, as run-controls.ts runs them ---------- */

describe("the spec checks' own controls", () => {
  const runControl = (c: Control): string[] => {
    const m: Machine = { ...stubMachine, ...(c.m ?? {}) };
    const hist = c.hist ?? histFromState(c.prev);
    const h2 = advance(hist, c.prev, c.e, c.next, c.effects);
    return [...checkTransition(c.prev, c.e, c.next, c.effects, m, hist), ...checkState(c.next, m, h2)];
  };
  const idOf = (v: string) => v.slice(0, v.indexOf(':'));

  it('every bad control is flagged by its own clause and no other; every good twin passes', () => {
    const failures: string[] = [];
    for (const c of CONTROLS) {
      if (!(c.clause in CLAUSES)) failures.push(`control for unknown clause ${c.clause}`);
      const v = runControl(c);
      if (c.good) {
        if (v.length) failures.push(`${c.clause} good twin flagged: ${v.join('; ')}`);
      } else {
        const ids = new Set(v.map(idOf));
        if (!ids.has(c.clause)) failures.push(`${c.clause} bad control not flagged by its clause`);
        const others = v.filter((x) => idOf(x) !== c.clause);
        if (others.length) failures.push(`${c.clause} bad control also flagged by: ${others.join('; ')}`);
      }
    }
    for (const id of Object.keys(CLAUSES)) {
      if (!CONTROLS.some((c) => c.clause === id && !c.good)) failures.push(`no bad control for ${id}`);
      if (!CONTROLS.some((c) => c.clause === id && c.good)) failures.push(`no good control for ${id}`);
    }
    expect(failures).toEqual([]);
    expect(Object.keys(CLAUSES).length).toBeGreaterThan(100);
  });

  it('every clause the checker can emit is in CLAUSES, and every clause is emitted', () => {
    const src = readFileSync(new URL('./lifecycle.spec-checks.ts', import.meta.url), 'utf8');
    const emitted = new Set<string>();
    for (const mm of src.matchAll(/\bv\(\s*'([A-Za-z0-9.\-]+)'/g)) emitted.add(mm[1]!);
    for (const mm of src.matchAll(/\?\s*'([A-Z0-9]+\.[a-z\-]+)'\s*:\s*'([A-Z0-9]+\.[a-z\-]+)'/g)) {
      emitted.add(mm[1]!);
      emitted.add(mm[2]!);
    }
    for (const s of ['launching', 'opening', 'initialized', 'walking', 'settling', 'grace', 'relaunch', 'closing']) emitted.add(`I5.${s}`);
    expect([...emitted].filter((id) => !(id in CLAUSES))).toEqual([]);
    expect(Object.keys(CLAUSES).filter((id) => !emitted.has(id))).toEqual([]);
  });
});

/* ---------- the walk with the spec's alphabet and checks ---------- */

/** A machine to walk: this repo's, or (in a probe) an older one. */
export interface Walked {
  readonly next: (s: LcState, e: LcEvent) => { readonly state: LcState; readonly effects: readonly LcEffect[] };
  readonly m: Machine;
  /** The spec's event as this machine takes it (undefined: not an event this machine can be given). */
  readonly adapt: (e: Spec.LcEvent, s: LcState) => LcEvent | undefined;
}

export const THIS: Walked = {
  next,
  // The spec's `fenced` is the declared one (lifecycle.spec-types.ts): "Whether a Start is fenced by a process
  // that may still run". This repo's own `fenced()` is a different predicate (Stop's fence, for idle pings),
  // so the spec's is given its declared meaning here.
  m: { callable, phaseOf, fenced: (s: LcState) => s.orphans.length > 0, offering, failureOf } as unknown as Machine,
  adapt: (e, s) => {
    if (e.t !== 'readmit') return e as unknown as LcEvent;
    const r = s.run;
    const launch = r?.launch ?? '';
    if (e.ok) return { t: 'readmit', run: e.run, facts: { ownerFree: true, enabled: true, launch } };
    if (e.off) return { t: 'readmit', run: e.run, facts: { ownerFree: true, enabled: false, launch } };
    return { t: 'readmit', run: e.run, facts: { ownerFree: false, ...(e.words !== undefined ? { ownerWords: e.words } : {}), enabled: true, launch } };
  }
};

export interface SpecOrigin {
  readonly name: string;
  readonly s: LcState;
  readonly h: History;
  readonly c: Ctx;
  readonly trace: readonly Spec.LcEvent[];
}
export const SPEC0 = (): SpecOrigin => ({ name: 'initial', s: initialState('s'), h: initialHistory(), c: CTX0, trace: [] });

interface Node {
  readonly s: LcState;
  readonly h: History;
  readonly c: Ctx;
  readonly step?: { readonly e: Spec.LcEvent; readonly up: Node['step'] };
}

export interface SpecResult {
  states: number;
  transitions: number;
  depth: number;
  ms: number;
  done: boolean;
  frontier: number;
  peakHeapMb: number;
  violation?: { trace: Spec.LcEvent[]; problems: string[] };
  /** With `collect`: the first (shortest) trace that broke each clause. */
  byClause?: Map<string, { trace: Spec.LcEvent[]; problem: string }>;
}

/** One transition: the machine's step on the adapted event, the spec's checks on the spec's event. */
export function stepSpec(w: Walked, s: LcState, h: History, e: Spec.LcEvent): { s: LcState; h: History; problems: string[] } | undefined {
  const me = w.adapt(e, s);
  if (!me) return undefined;
  const out = w.next(s, me);
  const se = e as unknown as Parameters<typeof checkTransition>[1];
  const ps = s as unknown as Parameters<typeof checkTransition>[0];
  const ns = out.state as unknown as Parameters<typeof checkTransition>[0];
  const fx = out.effects as unknown as Parameters<typeof checkTransition>[3];
  const problems = checkTransition(ps, se, ns, fx, w.m, h);
  const h2 = advance(h, ps, se, ns, fx);
  problems.push(...checkState(ns, w.m, h2));
  return { s: out.state, h: h2, problems };
}

/**
 * The (state, History, Ctx) triple with its names renumbered, as W's own fixpoint renumbers the state
 * (lifecycle.walk.test.ts): tokens, run ids and processes by their order of first appearance in the canonical
 * traversal (a process is its run's name with `:p`, as the alphabet mints it); deadline ids and catalog
 * generations by rank, since the alphabet takes the newest dead deadline ids and the machine and the checks
 * compare generations by order; and the state's counters that only mint fresh names dropped. Two triples
 * alike up to such renaming have alike futures: the machine, the checks and the alphabet compare these names
 * only for equality (deadline ids and generations for order too), and mint fresh ones above all present.
 * History lists every deadline id ever armed (`ids`), so ranking over it keeps their order exactly. The CI
 * check below compares the successors and verdicts of every pair this merges in an exact walk.
 */
export function renumberedSpec(s: LcState, h: History, c: Ctx): string {
  const GEN = new Set(['gen', 'firstGen', 'unsaved', 'saving', 'lastSave', 'lastPublish', 'last']);
  const DL = new Set(['saveBy', 'bound', 'deadline-id', 'ids']);
  const gens = new Set<number>([0]);
  const dls = new Set<number>();
  const see = (v: unknown, k?: string, inDeadline = false): void => {
    if (typeof v === 'number') {
      if (k !== undefined && GEN.has(k)) gens.add(v);
      if (k !== undefined && (DL.has(k) || (inDeadline && k === 'id'))) dls.add(v);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => see(x, k));
    const o = v as Record<string, unknown>;
    const dl = 'which' in o && typeof o.id === 'number';
    for (const kk in o) see(o[kk], kk, dl);
  };
  see(s);
  see(h);
  const rank = (xs: Set<number>, from: number) => new Map([...xs].sort((a, b) => a - b).map((x, i) => [x, i + from]));
  const genRank = rank(gens, 0);
  const dlRank = rank(dls, 1);
  const names = new Map<string, string>();
  const counts: Record<string, number> = {};
  const rename = (kind: string, v: string): string => {
    const key = `${kind}:${v}`;
    let out = names.get(key);
    if (out === undefined) names.set(key, (out = `${kind}${(counts[kind] = (counts[kind] ?? 0) + 1)}`));
    return out;
  };
  const str = (v: unknown, k?: string, top = false): string => {
    if (typeof v === 'string') {
      // A first Stop answer is kept as canonical JSON text: renumber what it names, too.
      if (k === 'reply' && v.startsWith('{')) return JSON.stringify(str(JSON.parse(v)));
      if (/^p\d+$/.test(v)) return JSON.stringify(rename('k', v));
      const proc = /^(.+#\d+):p$/.exec(v);
      if (proc) return JSON.stringify(`${rename('r', proc[1]!)}:p`);
      if (/^.+#\d+$/.test(v)) return JSON.stringify(rename('r', v));
      return JSON.stringify(v);
    }
    if (typeof v === 'number') {
      if (k !== undefined && GEN.has(k)) return String(genRank.get(v));
      if (k !== undefined && DL.has(k)) return `d${dlRank.get(v)}`;
      return String(v);
    }
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
    if (Array.isArray(v)) return `[${v.map((x) => str(x, k)).join(',')}]`;
    const o = v as Record<string, unknown>;
    const dl = 'which' in o && typeof o.id === 'number';
    const parts: string[] = [];
    for (const kk of Object.keys(o).sort()) {
      if (o[kk] === undefined || (top && SPEC_DROPPED.has(kk))) continue;
      parts.push(`${JSON.stringify(kk)}:${str(o[kk], dl && kk === 'id' ? 'deadline-id' : kk)}`);
    }
    return `{${parts.join(',')}}`;
  };
  return `[${str(s, undefined, true)},${str(h)},${str(c)}]`;
}
/** The state's counters that only mint fresh names, dropped from the renumbered form (its top level only). */
const SPEC_DROPPED = new Set(['nextRun', 'nextDeadline', 'nextGen']);

const keyOf = (n: { s: LcState; h: History; c: Ctx }, digest: boolean, renumber = false): string => {
  const text = renumber ? renumberedSpec(n.s, n.h, n.c) : canon([n.s, n.h, n.c]);
  return digest ? createHash('sha256').update(text).digest().toString('latin1') : text;
};

/** Breadth first, exactly deduplicated over (state, history, ctx): by canonical form, or (`renumber`) by the
    renumbered form; either one as itself or (`digest`) its SHA-256. */
export function walkSpec(w: Walked, where: Where, maxDepth: number, origin: SpecOrigin = SPEC0(), opts: { stopAtFirst?: boolean; collect?: boolean; digest?: boolean; renumber?: boolean; budgetMs?: number; progress?: (r: SpecResult) => void } = {}): SpecResult {
  const t0 = performance.now();
  const stopAtFirst = opts.stopAtFirst ?? true;
  const digest = !!opts.digest;
  const renumber = !!opts.renumber;
  const seen = new Set<string>([keyOf(origin, digest, renumber)]);
  let frontier: Node[] = [{ s: origin.s, h: origin.h, c: origin.c }];
  let transitions = 0;
  let depth = 0;
  let peak = 0;
  const byClause = new Map<string, { trace: Spec.LcEvent[]; problem: string }>();
  const traceOf = (n: Node['step']): Spec.LcEvent[] => {
    const out: Spec.LcEvent[] = [];
    for (let x = n; x; x = x.up) out.push(x.e);
    return [...origin.trace, ...out.reverse()];
  };
  const result = (extra: Partial<SpecResult> = {}): SpecResult => ({ states: seen.size, transitions, depth, ms: performance.now() - t0, done: frontier.length === 0, frontier: frontier.length, peakHeapMb: Math.round(peak / 2 ** 20), ...(opts.collect ? { byClause } : {}), ...extra });
  for (; depth < maxDepth && frontier.length; depth++) {
    if (opts.budgetMs !== undefined && performance.now() - t0 > opts.budgetMs) return result();
    const nf: Node[] = [];
    for (const n of frontier) {
      for (const [e, c2] of alphabet(n.s as never, n.h, n.c, where)) {
        const st = stepSpec(w, n.s, n.h, e);
        if (!st) continue;
        transitions++;
        const step = { e, up: n.step };
        if (st.problems.length) {
          if (opts.collect) for (const p of st.problems) {
            const id = p.slice(0, p.indexOf(':'));
            if (!byClause.has(id)) byClause.set(id, { trace: traceOf(step), problem: p });
          }
          if (stopAtFirst) return result({ depth: depth + 1, violation: { trace: traceOf(step), problems: st.problems } });
          if (opts.collect) continue;
        }
        const node: Node = { s: st.s, h: st.h, c: c2, step };
        const key = keyOf(node, digest, renumber);
        if (seen.has(key)) continue;
        seen.add(key);
        nf.push(node);
      }
    }
    frontier = nf;
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    opts.progress?.(result({ depth: depth + 1 }));
  }
  return result();
}

/* ---------- checkpoints, scripted through the spec's alphabet ---------- */

type Pick = (e: Spec.LcEvent, s: LcState) => boolean;
const is =
  (t: Spec.LcEvent['t'], more: (e: any) => boolean = () => true): Pick =>
  (e) =>
    e.t === t && more(e);
const forRun: Pick = (e, s) => !('run' in e) || (e as { run: string }).run === s.run?.id;

export function driveSpec(w: Walked, where: Where, name: string, picks: readonly Pick[], from: SpecOrigin = SPEC0()): SpecOrigin {
  let { s, h, c } = from;
  const trace = [...from.trace];
  for (const [i, p] of picks.entries()) {
    const choices = alphabet(s as never, h, c, where);
    let found = choices.find(([e]) => forRun(e, s) && p(e, s));
    // An exchange that has ended frees the slot first, as the world does.
    if (!found) {
      const free = choices.find(([e]) => e.t === 'slot' && e.idle);
      if (free) {
        const st = stepSpec(w, s, h, free[0])!;
        if (st.problems.length) throw new Error(`checkpoint ${name}: ${st.problems.join('; ')}`);
        trace.push(free[0]);
        ({ s, h } = st);
        c = free[1];
        found = alphabet(s as never, h, c, where).find(([e]) => forRun(e, s) && p(e, s));
      }
    }
    if (!found) throw new Error(`checkpoint ${name}: pick ${i} matches no event in ${s.run?.step ?? phaseOf(s)}`);
    const st = stepSpec(w, s, h, found[0]);
    if (!st) throw new Error(`checkpoint ${name}: pick ${i} isn't an event this machine takes`);
    if (st.problems.length) throw new Error(`checkpoint ${name}: ${st.problems.join('; ')}`);
    trace.push(found[0]);
    ({ s, h } = st);
    c = found[1];
  }
  return { name, s, h, c, trace };
}

const startOk = is('start', (e) => e.mode === 'start' && e.facts.record === 'ok' && e.facts.ownerFree);
const page = is('admin-done', (e) => e.outcome.k === 'page' && !e.outcome.more && e.outcome.catalog === 'ok');

/** The eight named checkpoints, through the spec's alphabet, with what each must be. */
export function specCheckpoints(w: Walked = THIS): { origin: SpecOrigin; where: Where; holds: (s: LcState) => boolean }[] {
  const saving = driveSpec(w, 'local', 'local Ready, its save in flight', [startOk, is('started', (e) => e.ok), is('admin-done', (e) => e.outcome.k === 'legacy'), is('admin-done', (e) => e.outcome.k === 'ok'), page, is('slot', (e) => e.idle)]);
  const ready = driveSpec(w, 'local', 'local Ready', [is('saved', (e) => e.outcome === 'saved')], saving);
  const refreshing = driveSpec(w, 'local', 'refreshing', [is('notice')], ready);
  const orphan = driveSpec(w, 'local', 'closing after a refused stop, the orphan open', [is('stop'), is('stop-answered', (e) => !e.ok)], ready);
  const run2 = driveSpec(w, 'local', "run 2 launching after run 1's orphan exited", [(e) => e.t === 'exit' && orphan.s.orphans.some((o) => o.process === (e as { process: string }).process), startOk], orphan);
  const relaunch = driveSpec(w, 'local', 'relaunch pending', [startOk, is('started', (e) => e.ok), is('admin-done', (e) => e.outcome.k === 'modern-refusal'), is('admin-done', (e) => e.outcome.k === 'unanswered'), is('exit')]);
  const rsaving = driveSpec(w, 'remote', 'remote Ready, its save in flight', [startOk, is('admin-done', (e) => e.outcome.k === 'legacy'), is('admin-done', (e) => e.outcome.k === 'ok'), page, is('slot', (e) => e.idle)]);
  const rready = driveSpec(w, 'remote', 'remote Ready', [is('saved', (e) => e.outcome === 'saved')], rsaving);
  const recovering = driveSpec(w, 'remote', 'remote recovering', [is('slot', (e) => !e.idle), is('call-ended', (e) => e.end === 'session-ended')], rready);
  return [
    { origin: ready, where: 'local', holds: (s) => phaseOf(s) === 'ready' && !s.saving },
    { origin: saving, where: 'local', holds: (s) => s.run?.step === 'ready' && !!s.saving },
    { origin: refreshing, where: 'local', holds: (s) => !!s.run && s.run.purpose === 'refresh' },
    { origin: orphan, where: 'local', holds: (s) => s.orphans.length === 1 && !s.run },
    { origin: relaunch, where: 'local', holds: (s) => s.run?.step === 'relaunch' },
    { origin: run2, where: 'local', holds: (s) => s.run?.step === 'launching' && s.orphans.length === 0 },
    { origin: rready, where: 'remote', holds: (s) => phaseOf(s) === 'ready' && !s.saving },
    { origin: recovering, where: 'remote', holds: (s) => s.run?.purpose === 'recovery' }
  ];
}

// The spec walk keys on state, History and Ctx, so it is far larger than W's own: CI walks it to depth 7 from
// the initial state and 5 from each checkpoint (W's own checks stay at 11 in lifecycle.walk.test.ts); the
// deep run is local (FAMILIAR_LC_SPEC_DEPTH, and the fixpoint).
const DEPTH = Number(process.env.FAMILIAR_LC_SPEC_DEPTH ?? 7);
const CP_DEPTH = Number(process.env.FAMILIAR_LC_SPEC_CP_DEPTH ?? 5);
const show = (t: readonly Spec.LcEvent[]) => t.map((e) => e.t + ('outcome' in e ? `:${(e.outcome as { k: string }).k}` : '') + ('ok' in e ? `:${e.ok}` : '')).join(' > ');

describe('W with the spec checks', () => {
  for (const where of ['local', 'remote'] as const)
    it(`the spec checks hold over every trace to depth ${DEPTH}, ${where}`, () => {
      const r = walkSpec(THIS, where, DEPTH);
      if (process.env.FAMILIAR_VERBOSE) console.log(`LC-SPEC ${where}: ${r.states} states, ${r.transitions} transitions, depth ${r.depth}, ${Math.round(r.ms)} ms`);
      expect(r.violation, r.violation ? `${r.violation.problems.join('; ')} after ${show(r.violation.trace)}` : '').toBeUndefined();
    }, 900_000);

  it('reaches each named checkpoint through the spec alphabet, each the state it names', () => {
    for (const k of specCheckpoints()) expect(k.holds(k.origin.s), k.origin.name).toBe(true);
  });

  for (const k of (() => {
    try {
      return specCheckpoints();
    } catch {
      return [];
    }
  })())
    it(`the spec checks hold to depth ${CP_DEPTH} from ${k.origin.name}`, () => {
      const r = walkSpec(THIS, k.where, CP_DEPTH, k.origin);
      if (process.env.FAMILIAR_VERBOSE) console.log(`LC-SPEC ${k.origin.name}: ${r.states} states, ${r.transitions} transitions, depth ${r.depth}, ${Math.round(r.ms)} ms`);
      expect(r.violation, r.violation ? `${r.violation.problems.join('; ')} after ${show(r.violation.trace)}` : '').toBeUndefined();
    }, 900_000);

  // Every lc-* guard broken, one at a time: the spec checks catch it (from the initial state or a named
  // checkpoint), and the violating trace replays clean on the unmutated machine.
  const LC: readonly (readonly [string, Where, string])[] = [
    ['lc-ready-before-idle', 'local', 'initial'],
    ['lc-ready-stale', 'local', 'refreshing'],
    ['lc-refresh-dropped', 'local', 'local Ready'],
    ['lc-relaunch-after-kill', 'local', 'initial'],
    ['lc-relaunch-on-answer', 'local', 'initial'],
    ['lc-stopped-on-refusal', 'local', 'local Ready'],
    ['lc-second-stop-stopped', 'local', 'closing after a refused stop, the orphan open'],
    ['lc-test-ok-on-refusal', 'local', 'initial'],
    ['lc-owner-held-on-stop', 'local', 'initial'],
    ['lc-no-stop-deadline', 'local', 'local Ready'],
    ['lc-two-native-stops', 'local', 'local Ready'],
    ['lc-readmit-after-stop', 'local', 'relaunch pending'],
    ['lc-start-beside-orphan', 'local', 'closing after a refused stop, the orphan open'],
    ['lc-save-overlap', 'local', 'local Ready, its save in flight'],
    ['lc-admit-after-fence', 'local', 'refreshing'],
    ['lc-era-on-recovery', 'remote', 'remote recovering'],
    ['lc-crash-words-lost', 'local', 'local Ready, its save in flight'],
    ['lc-start-deadline-dropped', 'local', 'initial'],
    ['lc-relaunch-fresh-budget', 'local', 'relaunch pending'],
    ['lc-late-start-unbounded', 'local', 'initial'],
    ['lc-test-ok-after-stop', 'local', 'initial'],
    ['lc-failed-save-dropped', 'local', 'local Ready'],
    ['lc-relaunch-keeps-exchange', 'local', 'initial'],
    ['lc-start-waits-cleanup', 'local', 'initial'],
    ['lc-taken-not-ended', 'local', 'initial']
  ];
  // lc-old-run-events is W's alone (lifecycle.walk.test.ts): it widens only `started`, and the spec world can't
  // deliver an old run's `started`, since a pending native start always belongs to the current run (I2.one, I6).
  const SPEC_CONTROL_DEPTH = Number(process.env.FAMILIAR_LC_SPEC_CONTROL_DEPTH ?? 7);
  // Three are not caught within the CI depth from these origins (W's own checks catch them in CI); their
  // spec-check catch is the local deep run's (FAMILIAR_LC_SPEC_DEEP=1, deeper).
  const DEEP = new Set(['lc-test-ok-on-refusal', 'lc-test-ok-after-stop', 'lc-failed-save-dropped']);
  for (const [mutation, where, from] of LC)
    it.skipIf(DEEP.has(mutation) && !process.env.FAMILIAR_LC_SPEC_DEEP)(`${mutation} is caught by the spec checks from ${from}, and its trace replays clean unmutated`, () => {
      const origin = from === 'initial' ? SPEC0() : specCheckpoints().find((k) => k.origin.name === from)!.origin;
      mutations.set([mutation]);
      let r: SpecResult;
      try {
        r = walkSpec(THIS, where, SPEC_CONTROL_DEPTH, origin);
      } finally {
        mutations.clear();
      }
      expect(r.violation, `${mutation}: no violation to depth ${SPEC_CONTROL_DEPTH} from ${from}`).toBeDefined();
      // The twin: the same trace on the unmutated machine breaks nothing.
      let s = initialState('s') as LcState;
      let h = initialHistory();
      const twin: string[] = [];
      for (const e of r.violation!.trace) {
        const st = stepSpec(THIS, s, h, e);
        if (!st) {
          twin.push(`${e.t} not an event this machine takes`);
          break;
        }
        twin.push(...st.problems);
        ({ s, h } = st);
      }
      expect(twin, `${mutation}'s trace on the unmutated machine`).toEqual([]);
    }, 900_000);

  // The renumbered key (the fixpoint's) merges only triples alike up to names: for every pair it merges in an
  // exact walk to depth 6, both have the same successors (by renumbered key) and the same verdicts (the clause
  // ids each transition breaks), event by event.
  const MERGE_DEPTH = Number(process.env.FAMILIAR_LC_SPEC_MERGE_DEPTH ?? 6);
  for (const where of ['local', 'remote'] as const)
    it(`renumbering merges only triples with alike futures, one step on, to depth ${MERGE_DEPTH}, ${where}`, () => {
      const succ = (n: { s: LcState; h: History; c: Ctx }) =>
        alphabet(n.s as never, n.h, n.c, where)
          .map(([e, c2]) => {
            const st = stepSpec(THIS, n.s, n.h, e);
            if (!st) return 'not taken';
            const verdict = [...new Set(st.problems.map((p) => p.slice(0, p.indexOf(':'))))].sort().join(',');
            return `${renumberedSpec(st.s, st.h, c2)}|${verdict}`;
          })
          .sort()
          .join('\n');
      const exact = new Set<string>();
      const reps = new Map<string, { s: LcState; h: History; c: Ctx }>();
      let merged = 0;
      const o = SPEC0();
      let frontier: { s: LcState; h: History; c: Ctx }[] = [{ s: o.s, h: o.h, c: o.c }];
      exact.add(canon([o.s, o.h, o.c]));
      reps.set(renumberedSpec(o.s, o.h, o.c), frontier[0]!);
      const bad: string[] = [];
      for (let d = 0; d < MERGE_DEPTH; d++) {
        const nf: typeof frontier = [];
        for (const n of frontier)
          for (const [e, c2] of alphabet(n.s as never, n.h, n.c, where)) {
            const st = stepSpec(THIS, n.s, n.h, e);
            if (!st) continue;
            const m = { s: st.s, h: st.h, c: c2 };
            const k = canon([m.s, m.h, m.c]);
            if (exact.has(k)) continue;
            exact.add(k);
            nf.push(m);
            const rk = renumberedSpec(m.s, m.h, m.c);
            const rep = reps.get(rk);
            if (!rep) reps.set(rk, m);
            else {
              merged++;
              if (bad.length < 3 && succ(m) !== succ(rep)) bad.push(`merged unlike triples: ${k.slice(0, 300)}`);
            }
          }
        frontier = nf;
      }
      if (process.env.FAMILIAR_VERBOSE) console.log(`LC-SPEC renumbering ${where}: ${exact.size} exact triples to depth ${MERGE_DEPTH}, ${reps.size} renumbered, ${merged} merged pairs checked`);
      expect(bad).toEqual([]);
      expect(merged).toBeGreaterThan(0);
    }, 900_000);

  const fixLog = (line: string) => {
    if (process.env.FAMILIAR_LC_LOG) appendFileSync(process.env.FAMILIAR_LC_LOG, `${new Date().toISOString()} ${line}\n`);
  };
  for (const where of ['local', 'remote'] as const)
    it.skipIf(!process.env.FAMILIAR_LC_SPEC_FIXPOINT)(`the spec checks hold to the fixpoint, ${where}`, () => {
      const fmt = (label: string, r: SpecResult) => `${label}: ${r.done ? 'fixpoint' : 'STOPPED'} at depth ${r.depth}, ${r.states} states, ${r.transitions} transitions, frontier ${r.frontier}, ${Math.round(r.ms / 1000)} s, peak heap ${r.peakHeapMb} MB${r.violation ? `, VIOLATION ${r.violation.problems.join('; ')} after ${show(r.violation.trace)}` : ''}`;
      // Keyed by the SHA-256 of the renumbered form (FAMILIAR_LC_SPEC_FIXPOINT=exact: of the plain canonical
      // form), for about 40 minutes at most. It doesn't empty in that time: the spec alphabet offers every
      // outcome at every point under Ctx's eight budgets, which multiply the states far more than History
      // does, and renumbering merges only a few percent. At becbdf0, no violation: local stopped after depth
      // 12 (1,911,897 states, 13,094,456 transitions, frontier 1,079,770, 2,565 s); remote after depth 14
      // (934,600 states, 8,080,085 transitions, frontier 426,608, 2,925 s); peak heap 3.5 GB.
      const renumber = process.env.FAMILIAR_LC_SPEC_FIXPOINT !== 'exact';
      const r = walkSpec(THIS, where, Infinity, SPEC0(), { digest: true, renumber, budgetMs: 40 * 60_000, progress: (p) => fixLog(fmt(`spec progress ${where}${renumber ? ' renumbered' : ''}`, p)) });
      fixLog(fmt(`SPEC FIXPOINT ${where}${renumber ? ' renumbered' : ''}`, r));
      expect(r.violation, r.violation?.problems.join('; ')).toBeUndefined();
      expect(r.done, `stopped at depth ${r.depth} with ${r.frontier} in the frontier`).toBe(true);
    }, 45 * 60_000);
});

export { mutations };
