// The machine under seeded random interleavings of commands and events, late ones and ones from old runs
// included. A fake world does what the effects ask, slowly and in any order. After each sequence every
// pending event is delivered and every timer fired, and then:
//   - every call, start, stop and remove was answered exactly once
//   - the machine rests
//   - an answer from an old run never answered a call sent on another run, and no effect named a run
//     that wasn't current
//   - no call was sent twice, so a crash mid-call never sent it again
//   - no run started while an earlier one was still open
import { describe, expect, it } from 'vitest';
import { createMachine, DEFAULT_LIMITS, resting, step, type Effect, type Input, type Machine } from '../../src/mcp/machine.ts';
import type { CallOutcome, Reply } from '../../src/mcp/types.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Run { gen: number; stage: 'starting' | 'launched' | 'ready' | 'closed'; halted: boolean; stopExpired: boolean }

class World {
  m: Machine = createMachine({ ...DEFAULT_LIMITS, maxCalls: 6 });
  now = 0;
  token = 0;
  runs = new Map<number, Run>();
  /** Events the world will deliver, in any order. */
  pending: Input[] = [];
  timers = new Map<string, number>();
  sentOn = new Map<number, number>();
  answers = new Map<number, CallOutcome[]>();
  replies = new Map<number, Reply[]>();
  calls = new Set<number>();
  commands = new Set<number>();
  forgetFails: () => boolean;
  problems: string[] = [];
  private r: () => number;

  constructor(r: () => number) {
    this.r = r;
    this.forgetFails = () => r() < 1 / 3;
  }

  feed(input: Input, origin?: { resultGen: number }) {
    const fx = step(this.m, input, this.now);
    for (const e of fx) this.effect(e, input, origin);
  }

  effect(e: Effect, input: Input, origin?: { resultGen: number }) {
    const bad = (s: string) => this.problems.push(`${s} (after ${JSON.stringify(input)})`);
    switch (e.t) {
      case 'launch':
        if (e.gen !== this.m.gen) bad(`launch of gen ${e.gen}, current ${this.m.gen}`);
        for (const r of this.runs.values()) if (r.stage !== 'closed' && !(r.halted && r.stopExpired)) bad(`run ${e.gen} launched while run ${r.gen} is open`);
        this.runs.set(e.gen, { gen: e.gen, stage: 'starting', halted: false, stopExpired: false });
        return;
      case 'send':
        if (e.gen !== this.m.gen) bad(`send on gen ${e.gen}, current ${this.m.gen}`);
        if (this.sentOn.has(e.call)) bad(`call ${e.call} sent twice`);
        this.sentOn.set(e.call, e.gen);
        this.pending.push({ t: 'result', gen: e.gen, call: e.call, outcome: { kind: 'result', text: `r${e.call}`, isError: false } });
        return;
      case 'abort':
        if (this.sentOn.get(e.call) !== e.gen) bad(`abort of call ${e.call} on gen ${e.gen}, sent on ${this.sentOn.get(e.call)}`);
        return;
      case 'list':
        if (e.gen !== this.m.gen) bad(`list on old gen ${e.gen}`);
        this.pending.push({ t: 'listed', gen: e.gen, tools: [] });
        return;
      case 'halt': {
        if (e.gen !== this.m.gen) bad(`halt of old gen ${e.gen}`);
        const r = this.runs.get(e.gen);
        if (r && !r.halted) {
          r.halted = true;
          this.pending.push({ t: 'closed', gen: e.gen });
        }
        return;
      }
      case 'forget':
        this.pending.push(this.forgetFails() ? { t: 'forgotten', failure: { kind: 'failed', words: 'no' } } : { t: 'forgotten' });
        return;
      case 'arm':
        this.timers.set(e.key, e.at);
        return;
      case 'disarm':
        this.timers.delete(e.key);
        return;
      case 'answer': {
        if (!this.calls.has(e.call)) bad(`answer for unknown call ${e.call}`);
        const list = this.answers.get(e.call) ?? [];
        list.push(e.outcome);
        this.answers.set(e.call, list);
        if (list.length > 1) bad(`call ${e.call} answered ${list.length} times`);
        if (input.t === 'result' && e.outcome.kind === 'result' && origin && this.sentOn.get(e.call) !== origin.resultGen) bad(`call ${e.call} answered by gen ${origin.resultGen}`);
        if (e.outcome.kind === 'interrupted' && !this.sentOn.has(e.call)) bad(`call ${e.call} interrupted but never sent`);
        return;
      }
      case 'reply': {
        if (!this.commands.has(e.token)) bad(`reply for unknown token ${e.token}`);
        const list = this.replies.get(e.token) ?? [];
        list.push(e.reply);
        this.replies.set(e.token, list);
        if (list.length > 1) bad(`token ${e.token} replied ${list.length} times`);
        return;
      }
      case 'changed':
        return;
    }
  }

  command(kind: 'start' | 'stop' | 'remove' | 'call') {
    const token = ++this.token;
    if (kind === 'call') {
      this.calls.add(token);
      this.feed({ t: 'call', token, tool: 't', args: {}, ms: this.r() < 0.3 ? 1000 + Math.floor(this.r() * 5000) : undefined });
    } else {
      this.commands.add(token);
      this.feed({ t: kind, token });
    }
  }

  /** Moves one run on: started, ready or crashed. */
  progress(run: Run, crash: boolean) {
    if (run.stage === 'closed') return;
    if (crash || run.halted) {
      run.stage = 'closed';
      this.feed({ t: 'closed', gen: run.gen, failure: crash ? { kind: 'exited', words: 'crashed' } : undefined });
      return;
    }
    if (run.stage === 'starting') {
      run.stage = 'launched';
      this.feed({ t: 'launched', gen: run.gen });
    } else if (run.stage === 'launched') {
      run.stage = 'ready';
      this.feed({ t: 'ready', gen: run.gen, tools: [] });
    }
  }

  deliver(i: number) {
    const [input] = this.pending.splice(i, 1);
    if (!input) return;
    if (input.t === 'closed') {
      const run = this.runs.get(input.gen);
      if (run) run.stage = 'closed';
    }
    this.feed(input, input.t === 'result' ? { resultGen: input.gen } : undefined);
  }

  fire(key: string) {
    const at = this.timers.get(key);
    if (at === undefined) return;
    this.timers.delete(key);
    this.now = Math.max(this.now, at);
    if (key.startsWith('stop:')) {
      const run = this.runs.get(Number(key.slice(5)));
      if (run) run.stopExpired = true;
    }
    this.feed({ t: 'timer', key });
  }

  earliestTimer(): string | undefined {
    let best: [string, number] | undefined;
    for (const [k, at] of this.timers) if (!best || at < best[1]) best = [k, at];
    return best?.[0];
  }

  /** A late or stale event, as a transport might send one. */
  stale() {
    const gens = [...this.runs.keys()].filter(g => g !== this.m.gen);
    if (gens.length === 0) return;
    const gen = gens[Math.floor(this.r() * gens.length)]!;
    const calls = [...this.sentOn.keys()];
    const call = calls.length ? calls[Math.floor(this.r() * calls.length)]! : 1;
    const pick: Input[] = [
      { t: 'launched', gen }, { t: 'ready', gen, tools: [] }, { t: 'closed', gen }, { t: 'tools-changed', gen },
      { t: 'result', gen, call, outcome: { kind: 'result', text: 'stale', isError: false } }
    ];
    const input = pick[Math.floor(this.r() * pick.length)]!;
    this.feed(input, input.t === 'result' ? { resultGen: gen } : undefined);
  }

  randomStep() {
    const x = this.r();
    const current = this.runs.get(this.m.gen);
    if (x < 0.1) this.command('start');
    else if (x < 0.15) this.command('stop');
    else if (x < 0.18) this.command('remove');
    else if (x < 0.38) this.command('call');
    else if (x < 0.43) {
      const open = [...this.calls].filter(c => !this.answers.has(c));
      if (open.length) this.feed({ t: 'cancel', call: open[Math.floor(this.r() * open.length)]! });
    } else if (x < 0.46) this.feed({ t: 'refresh' });
    else if (x < 0.48 && current) this.feed({ t: 'tools-changed', gen: current.gen });
    else if (x < 0.62 && this.pending.length) this.deliver(Math.floor(this.r() * this.pending.length));
    else if (x < 0.75 && current) this.progress(current, false);
    else if (x < 0.82 && current) this.progress(current, true);
    else if (x < 0.92) {
      const keys = [...this.timers.keys()];
      if (keys.length) this.fire(keys[Math.floor(this.r() * keys.length)]!);
    } else if (x < 0.96) this.stale();
    else this.now += Math.floor(this.r() * 120_000);
  }

  drain() {
    for (let guard = 0; guard < 10_000; guard++) {
      if (this.pending.length) { this.deliver(0); continue; }
      const current = this.runs.get(this.m.gen);
      if (current && current.stage !== 'closed' && current.stage !== 'ready') { this.progress(current, false); continue; }
      if (current && current.halted && current.stage !== 'closed') { this.progress(current, false); continue; }
      const key = this.earliestTimer();
      if (key) { this.fire(key); continue; }
      return;
    }
    this.problems.push('drain did not settle');
  }
}

function run(seed: number, steps: number): string[] {
  const w = new World(rng(seed));
  for (let i = 0; i < steps; i++) w.randomStep();
  w.drain();
  for (const c of w.calls) if ((w.answers.get(c)?.length ?? 0) !== 1) w.problems.push(`call ${c} answered ${w.answers.get(c)?.length ?? 0} times`);
  for (const t of w.commands) if ((w.replies.get(t)?.length ?? 0) !== 1) w.problems.push(`token ${t} replied ${w.replies.get(t)?.length ?? 0} times`);
  if (!resting(w.m)) w.problems.push(`ended in ${w.m.phase}`);
  if (w.m.calls.size) w.problems.push(`${w.m.calls.size} calls left`);
  return w.problems.map(p => `seed ${seed}: ${p}`);
}

describe('the server machine, under random interleavings', () => {
  it('answers everything once, rests, keeps runs apart and never sends a call twice', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 5000; seed++) problems.push(...run(seed, 60));
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it('long sequences too', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 300; seed++) problems.push(...run(10_000 + seed, 400));
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it('a crash mid-call answers it interrupted, and the restart sends only what was never sent', () => {
    const m = createMachine();
    const fx: Effect[] = [];
    const feed = (i: Input, now = 0) => fx.push(...step(m, i, now));
    feed({ t: 'start', token: 1 });
    feed({ t: 'launched', gen: 1 });
    feed({ t: 'ready', gen: 1, tools: [] });
    feed({ t: 'call', token: 2, tool: 'crash', args: {} });
    feed({ t: 'closed', gen: 1, failure: { kind: 'exited', words: 'It exited.' } }, 10);
    expect(m.phase).toBe('restarting');
    feed({ t: 'call', token: 3, tool: 'echo', args: {} }, 20);
    feed({ t: 'timer', key: 'restart:1' }, 1010);
    feed({ t: 'launched', gen: 2 }, 1020);
    feed({ t: 'ready', gen: 2, tools: [] }, 1030);
    const sends = fx.filter(e => e.t === 'send').map(e => (e as { call: number; gen: number }));
    expect(sends).toEqual([{ t: 'send', gen: 1, call: 2, tool: 'crash', args: {} }, { t: 'send', gen: 2, call: 3, tool: 'echo', args: {} }]);
    expect(fx).toContainEqual({ t: 'answer', call: 2, outcome: { kind: 'interrupted' } });
  });

  it('three crashes in the window: down, with the failure kept', () => {
    const m = createMachine();
    let now = 0;
    step(m, { t: 'start', token: 1 }, now);
    for (let gen = 1; gen <= 3; gen++) {
      step(m, { t: 'launched', gen }, now);
      step(m, { t: 'ready', gen, tools: [] }, now);
      now += 1000;
      step(m, { t: 'closed', gen, failure: { kind: 'exited', words: `crash ${gen}`, lastOutput: 'boom' } }, now);
      if (gen < 3) step(m, { t: 'timer', key: `restart:${gen}` }, (now += 1000));
    }
    expect(m.phase).toBe('down');
    expect(m.failure).toMatchObject({ words: 'crash 3', lastOutput: 'boom' });
    // A crash outside the window doesn't count.
    const m2 = createMachine();
    now = 0;
    step(m2, { t: 'start', token: 1 }, now);
    for (let gen = 1; gen <= 3; gen++) {
      step(m2, { t: 'launched', gen }, now);
      step(m2, { t: 'ready', gen, tools: [] }, now);
      now += 6 * 60_000;
      step(m2, { t: 'closed', gen }, now);
      step(m2, { t: 'timer', key: `restart:${gen}` }, (now += 1000));
    }
    expect(m2.phase).toBe('starting');
  });

  it("the person's own start that fails isn't tried again", () => {
    const m = createMachine();
    const fx = [...step(m, { t: 'start', token: 1 }, 0), ...step(m, { t: 'closed', gen: 1, failure: { kind: 'declined', words: 'You said no.' } }, 0)];
    expect(m.phase).toBe('stopped');
    expect(fx).toContainEqual({ t: 'reply', token: 1, reply: { kind: 'failed', failure: { kind: 'declined', words: 'You said no.' } } });
    expect(fx.some(e => e.t === 'arm' && e.key.startsWith('restart'))).toBe(false);
  });

  it('the handshake deadline ends the run and says so', () => {
    const m = createMachine();
    const fx = [...step(m, { t: 'start', token: 1 }, 0), ...step(m, { t: 'launched', gen: 1 }, 0)];
    fx.push(...step(m, { t: 'timer', key: 'init:1' }, DEFAULT_LIMITS.initMs));
    expect(fx).toContainEqual({ t: 'halt', gen: 1 });
    // A ready that comes after the deadline is too late.
    fx.push(...step(m, { t: 'ready', gen: 1, tools: [] }, DEFAULT_LIMITS.initMs + 1));
    expect(m.phase).toBe('initializing');
    fx.push(...step(m, { t: 'closed', gen: 1 }, DEFAULT_LIMITS.initMs + 2));
    expect(m.phase).toBe('stopped');
    expect(m.failure?.kind).toBe('timed-out');
  });
});
