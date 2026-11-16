// The machine under seeded random interleavings of commands and events, late ones and ones from old runs
// included. A fake world does what the effects ask, slowly, in any order, sometimes never: a start, a
// save, a removal or a tool list can hang for ever, and the server can send storms of "tools changed".
// After each sequence every pending event is delivered and every timer fired, and then:
//   - every call, start, stop, edit and remove was answered exactly once
//   - the machine rests
//   - an answer from an old run never answered a call sent on another run, and no effect named a run
//     that wasn't current
//   - no call was sent twice, so a crash mid-call never sent it again
//   - no run started while an earlier one was still open
//   - a call made for a tool was sent only while the server offered exactly that tool from that setup,
//     and never while its tool list was stale
//   - at most one tool list, one save and one removal was under way, and an older list never replaced a
//     newer one
//   - no waiting list grew past its bound
import { describe, expect, it } from 'vitest';
import { createMachine, DEFAULT_LIMITS, resting, step, type Effect, type Expect, type Input, type Machine } from '../../src/mcp/machine.ts';
import type { CallOutcome, ListedTool, Reply } from '../../src/mcp/types.ts';

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

const tools = (fp: string): ListedTool[] => [{ name: 't', inputSchema: {}, fingerprint: fp }];
const SETUPS = ['s1', 's2'];
const FPS = ['fa', 'fb'];

interface Run { gen: number; stage: 'starting' | 'launched' | 'ready' | 'closed'; halted: boolean; stopExpired: boolean; hung: boolean; setup: string }

class World {
  m: Machine = createMachine({ ...DEFAULT_LIMITS, maxCalls: 6, maxWaiters: 3 });
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
  expects = new Map<number, Expect>();
  /** The setup as the actor would hold it: committed only when its save is answered `edited`. */
  committed = 's1';
  edits = new Map<number, string>();
  /** The newest tool list asked for, per run. */
  newestList = new Map<number, number>();
  problems: string[] = [];
  private r: () => number;

  constructor(r: () => number) {
    this.r = r;
  }

  feed(input: Input, origin?: { resultGen: number }) {
    const listingBefore = this.m.listing;
    const forgettingBefore = this.m.forgetting;
    const editingBefore = this.m.editing;
    const toolsBefore = this.m.tools;
    const newestBefore = 'gen' in input ? this.newestList.get(input.gen) : undefined;
    const fx = step(this.m, input, this.now);
    const bad = (s: string) => this.problems.push(`${s} (after ${JSON.stringify(input)})`);
    if (fx.filter(e => e.t === 'list').length > 1) bad('two tool lists asked for at once');
    if (fx.some(e => e.t === 'forget') && forgettingBefore !== undefined) bad(`a removal asked for while removal ${forgettingBefore} was under way`);
    if (fx.some(e => e.t === 'save') && editingBefore !== undefined) bad(`a save asked for while save ${editingBefore.n} was under way`);
    for (const e of fx) this.effect(e, input, listingBefore, origin);
    if (input.t === 'listed' && this.m.tools !== toolsBefore && input.n !== newestBefore) bad(`list ${input.n} applied, but ${newestBefore} is newer`);
    for (const [name, list] of [['starts', this.m.starts], ['stops', this.m.stops], ['removes', this.m.removes]] as const) {
      if (list.length > this.m.limits.maxWaiters) bad(`${list.length} ${name} waiting`);
    }
  }

  effect(e: Effect, input: Input, listingBefore: number | undefined, origin?: { resultGen: number }) {
    const bad = (s: string) => this.problems.push(`${s} (after ${JSON.stringify(input)})`);
    switch (e.t) {
      case 'launch':
        if (e.gen !== this.m.gen) bad(`launch of gen ${e.gen}, current ${this.m.gen}`);
        for (const r of this.runs.values()) if (r.stage !== 'closed' && !(r.halted && r.stopExpired)) bad(`run ${e.gen} launched while run ${r.gen} is open`);
        this.runs.set(e.gen, { gen: e.gen, stage: 'starting', halted: false, stopExpired: false, hung: this.r() < 0.1, setup: this.committed });
        return;
      case 'send': {
        if (e.gen !== this.m.gen) bad(`send on gen ${e.gen}, current ${this.m.gen}`);
        if (this.sentOn.has(e.call)) bad(`call ${e.call} sent twice`);
        if (this.m.stale) bad(`call ${e.call} sent while the tool list was stale`);
        const want = this.expects.get(e.call);
        if (want && (want.setup !== this.m.setup || this.m.catalog.get('t') !== want.tool)) bad(`call ${e.call} sent for ${JSON.stringify(want)}, but the server offers ${this.m.catalog.get('t')} from ${this.m.setup}`);
        this.sentOn.set(e.call, e.gen);
        this.pending.push({ t: 'result', gen: e.gen, call: e.call, outcome: { kind: 'result', text: `r${e.call}`, isError: false } });
        return;
      }
      case 'abort':
        if (this.sentOn.get(e.call) !== e.gen) bad(`abort of call ${e.call} on gen ${e.gen}, sent on ${this.sentOn.get(e.call)}`);
        return;
      case 'list': {
        if (e.gen !== this.m.gen) bad(`list on old gen ${e.gen}`);
        if (listingBefore !== undefined && !(input.t === 'listed' && input.n === listingBefore)) bad(`list ${e.n} asked for while list ${listingBefore} was under way`);
        this.newestList.set(e.gen, e.n);
        const x = this.r();
        if (x < 0.15) return; // never answered
        this.pending.push(x < 0.25 ? { t: 'list-failed', gen: e.gen, n: e.n, failure: { kind: 'protocol', words: 'bad list' } } : { t: 'listed', gen: e.gen, n: e.n, tools: tools(FPS[Math.floor(this.r() * 2)]!) });
        return;
      }
      case 'halt': {
        if (e.gen !== this.m.gen) bad(`halt of old gen ${e.gen}`);
        const r = this.runs.get(e.gen);
        if (r && !r.halted) {
          r.halted = true;
          if (!r.hung || this.r() < 0.5) this.pending.push({ t: 'closed', gen: e.gen });
        }
        return;
      }
      case 'save': {
        const x = this.r();
        if (x < 0.15) return; // never answered
        this.pending.push(x < 0.3 ? { t: 'saved', n: e.n, failure: { kind: 'failed', words: 'no' } } : { t: 'saved', n: e.n });
        return;
      }
      case 'forget': {
        const x = this.r();
        if (x < 0.15) return; // never answered
        this.pending.push(x < 0.4 ? { t: 'forgotten', n: e.n, failure: { kind: 'failed', words: 'no' } } : { t: 'forgotten', n: e.n });
        return;
      }
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
        const edited = this.edits.get(e.token);
        if (edited !== undefined && e.reply.kind === 'edited') this.committed = edited;
        return;
      }
      case 'changed':
        return;
    }
  }

  command(kind: 'start' | 'stop' | 'remove' | 'call' | 'edit') {
    const token = ++this.token;
    if (kind === 'call') {
      this.calls.add(token);
      const expect = this.r() < 0.5 ? { setup: SETUPS[Math.floor(this.r() * 2)]!, tool: FPS[Math.floor(this.r() * 2)]! } : undefined;
      if (expect) this.expects.set(token, expect);
      this.feed({ t: 'call', token, tool: 't', args: {}, ms: this.r() < 0.3 ? 1000 + Math.floor(this.r() * 5000) : undefined, ...(expect ? { expect } : {}) });
    } else {
      this.commands.add(token);
      if (kind === 'edit') this.edits.set(token, this.committed === 's1' ? 's2' : 's1');
      this.feed({ t: kind, token });
    }
  }

  /** Moves one run on: started, ready or crashed. A hung run never starts on its own. */
  progress(run: Run, crash: boolean) {
    if (run.stage === 'closed') return;
    if (crash || (run.halted && !run.hung)) {
      run.stage = 'closed';
      this.feed({ t: 'closed', gen: run.gen, failure: crash ? { kind: 'exited', words: 'crashed' } : undefined });
      return;
    }
    if (run.hung) return;
    if (run.stage === 'starting') {
      run.stage = 'launched';
      this.feed({ t: 'launched', gen: run.gen });
    } else if (run.stage === 'launched') {
      run.stage = 'ready';
      this.feed({ t: 'ready', gen: run.gen, tools: tools(FPS[Math.floor(this.r() * 2)]!), setup: run.setup });
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
    const gens = [...this.runs.keys()];
    if (gens.length === 0) return;
    const gen = gens[Math.floor(this.r() * gens.length)]!;
    const calls = [...this.sentOn.keys()];
    const call = calls.length ? calls[Math.floor(this.r() * calls.length)]! : 1;
    const n = Math.floor(this.r() * (this.m.seq + 1));
    const pick: Input[] = [
      { t: 'launched', gen }, { t: 'ready', gen, tools: tools('fa'), setup: 's1' }, { t: 'closed', gen }, { t: 'tools-changed', gen },
      { t: 'result', gen, call, outcome: { kind: 'result', text: 'stale', isError: false } },
      { t: 'listed', gen, n, tools: tools('fb') }, { t: 'saved', n }, { t: 'forgotten', n }
    ];
    // Only an old run's events, or an old number's: the current ones are the world's to send. An old
    // list's answer may come on the current run.
    const input = pick[Math.floor(this.r() * pick.length)]!;
    if ('gen' in input && input.gen === this.m.gen && input.t !== 'listed') return;
    if ((input.t === 'listed' && input.n === this.m.listing) || (input.t === 'saved' && input.n === this.m.editing?.n) || (input.t === 'forgotten' && input.n === this.m.forgetting)) return;
    this.feed(input, input.t === 'result' ? { resultGen: gen } : undefined);
  }

  randomStep() {
    const x = this.r();
    const current = this.runs.get(this.m.gen);
    if (x < 0.09) this.command('start');
    else if (x < 0.14) this.command('stop');
    else if (x < 0.17) this.command('remove');
    else if (x < 0.2) this.command('edit');
    else if (x < 0.36) this.command('call');
    else if (x < 0.4) {
      const open = [...this.calls].filter(c => !this.answers.has(c));
      if (open.length) this.feed({ t: 'cancel', call: open[Math.floor(this.r() * open.length)]! });
    } else if (x < 0.42) this.feed({ t: 'refresh' });
    else if (x < 0.45 && current) {
      // A storm: the server says its tools changed, many times over.
      const n = this.r() < 0.3 ? 50 : 1;
      for (let i = 0; i < n; i++) this.feed({ t: 'tools-changed', gen: current.gen });
    } else if (x < 0.58 && this.pending.length) this.deliver(Math.floor(this.r() * this.pending.length));
    else if (x < 0.7 && current) this.progress(current, false);
    else if (x < 0.76 && current) this.progress(current, true);
    else if (x < 0.88) {
      const keys = [...this.timers.keys()];
      if (keys.length) this.fire(keys[Math.floor(this.r() * keys.length)]!);
    } else if (x < 0.95) this.stale();
    else this.now += Math.floor(this.r() * 120_000);
  }

  drain() {
    for (let guard = 0; guard < 20_000; guard++) {
      if (this.pending.length) { this.deliver(0); continue; }
      const current = this.runs.get(this.m.gen);
      if (current && !current.hung && current.stage !== 'closed' && (current.stage !== 'ready' || current.halted)) { this.progress(current, false); continue; }
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
  if (!resting(w.m)) w.problems.push(`ended in ${w.m.phase}${w.m.editing ? ' editing' : ''}${w.m.listing !== undefined ? ' listing' : ''}${w.m.stale ? ' stale' : ''}`);
  if (w.m.calls.size) w.problems.push(`${w.m.calls.size} calls left`);
  return w.problems.map(p => `seed ${seed}: ${p}`);
}

describe('the server machine, under random interleavings', () => {
  it('answers everything once, rests, keeps runs apart and never sends a call twice or for a changed tool', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 5000; seed++) problems.push(...run(seed, 60));
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it('long sequences too', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 300; seed++) problems.push(...run(10_000 + seed, 400));
    expect(problems.slice(0, 10)).toEqual([]);
  });
});

describe('the server machine, case by case', () => {
  const ready = (m: Machine, gen = 1, fp = 'fa', setup = 's1', now = 0) => [
    ...step(m, { t: 'launched', gen }, now),
    ...step(m, { t: 'ready', gen, tools: tools(fp), setup }, now)
  ];

  it('a crash mid-call answers it interrupted, and the restart sends only what was never sent', () => {
    const m = createMachine();
    const fx: Effect[] = [];
    const feed = (i: Input, now = 0) => fx.push(...step(m, i, now));
    feed({ t: 'start', token: 1 });
    fx.push(...ready(m));
    feed({ t: 'call', token: 2, tool: 'crash', args: {} });
    feed({ t: 'closed', gen: 1, failure: { kind: 'exited', words: 'It exited.' } }, 10);
    expect(m.phase).toBe('restarting');
    feed({ t: 'call', token: 3, tool: 'echo', args: {} }, 20);
    feed({ t: 'timer', key: 'restart:1' }, 1010);
    fx.push(...ready(m, 2, 'fa', 's1', 1020));
    const sends = fx.filter(e => e.t === 'send');
    expect(sends).toEqual([{ t: 'send', gen: 1, call: 2, tool: 'crash', args: {} }, { t: 'send', gen: 2, call: 3, tool: 'echo', args: {} }]);
    expect(fx).toContainEqual({ t: 'answer', call: 2, outcome: { kind: 'interrupted' } });
  });

  it('three crashes in the window: down, with the failure kept', () => {
    const m = createMachine();
    let now = 0;
    step(m, { t: 'start', token: 1 }, now);
    for (let gen = 1; gen <= 3; gen++) {
      ready(m, gen, 'fa', 's1', now);
      now += 1000;
      step(m, { t: 'closed', gen, failure: { kind: 'exited', words: `crash ${gen}`, lastOutput: 'boom' } }, now);
      if (gen < 3) step(m, { t: 'timer', key: `restart:${gen}` }, (now += 1000));
    }
    expect(m.phase).toBe('down');
    expect(m.failure).toMatchObject({ words: 'crash 3', lastOutput: 'boom' });
  });

  it("the person's own start that fails isn't tried again", () => {
    const m = createMachine();
    const fx = [...step(m, { t: 'start', token: 1 }, 0), ...step(m, { t: 'closed', gen: 1, failure: { kind: 'declined', words: 'You said no.' } }, 0)];
    expect(m.phase).toBe('stopped');
    expect(fx).toContainEqual({ t: 'reply', token: 1, reply: { kind: 'failed', failure: { kind: 'declined', words: 'You said no.' } } });
    expect(fx.some(e => e.t === 'arm' && e.key.startsWith('restart'))).toBe(false);
  });

  it('r19 #9: Ready, Stop A, Start B while stopping, Stop C: B is settled by C and no run starts', () => {
    const m = createMachine();
    step(m, { t: 'start', token: 1 }, 0);
    ready(m);
    const fx = [
      ...step(m, { t: 'stop', token: 2 }, 0),
      ...step(m, { t: 'start', token: 3 }, 0),
      ...step(m, { t: 'stop', token: 4 }, 0),
      ...step(m, { t: 'closed', gen: 1 }, 0)
    ];
    expect(fx).toContainEqual({ t: 'reply', token: 3, reply: { kind: 'stopped' } });
    expect(fx.filter(e => e.t === 'launch')).toEqual([]);
    expect(m.phase).toBe('stopped');
    // A start after the last stop does launch.
    const after = [...step(m, { t: 'stop', token: 5 }, 0), ...step(m, { t: 'start', token: 6 }, 0)];
    expect(after.filter(e => e.t === 'launch')).toHaveLength(1);
  });

  it('a start that never answers, and the dialog with it, ends at its deadline', () => {
    const m = createMachine();
    step(m, { t: 'start', token: 1 }, 0);
    const fx = step(m, { t: 'timer', key: 'start:1' }, DEFAULT_LIMITS.startMs);
    expect(fx).toContainEqual({ t: 'halt', gen: 1 });
    const end = step(m, { t: 'timer', key: 'stop:1' }, DEFAULT_LIMITS.startMs + DEFAULT_LIMITS.stopMs);
    expect(m.phase).toBe('stopped');
    expect(end).toContainEqual({ t: 'reply', token: 1, reply: { kind: 'failed', failure: { kind: 'timed-out', words: `The server didn't start within ${DEFAULT_LIMITS.startMs / 1000} seconds.` } } });
  });

  it('the handshake deadline ends the run and says so', () => {
    const m = createMachine();
    step(m, { t: 'start', token: 1 }, 0);
    step(m, { t: 'launched', gen: 1 }, 0);
    expect(step(m, { t: 'timer', key: 'init:1' }, DEFAULT_LIMITS.initMs)).toContainEqual({ t: 'halt', gen: 1 });
    step(m, { t: 'ready', gen: 1, tools: [], setup: 's1' }, DEFAULT_LIMITS.initMs + 1);
    expect(m.phase).toBe('initializing');
    step(m, { t: 'closed', gen: 1 }, DEFAULT_LIMITS.initMs + 2);
    expect(m.phase).toBe('stopped');
    expect(m.failure?.kind).toBe('timed-out');
  });

  it('a removal that never answers fails at its deadline, a late answer is dropped, and the next remove tries again', () => {
    const m = createMachine();
    step(m, { t: 'remove', token: 1 }, 0);
    const fx = step(m, { t: 'timer', key: 'forget:1' }, DEFAULT_LIMITS.saveMs);
    expect(fx).toContainEqual({ t: 'reply', token: 1, reply: { kind: 'failed', failure: expect.objectContaining({ kind: 'timed-out' }) } });
    step(m, { t: 'forgotten', n: 1 }, DEFAULT_LIMITS.saveMs + 1);
    expect(m.phase).toBe('removing');
    expect(step(m, { t: 'remove', token: 2 }, 0)).toContainEqual({ t: 'forget', n: 2 });
    step(m, { t: 'forgotten', n: 2 }, 0);
    expect(m.phase).toBe('removed');
  });

  it('an edit is admitted only while stopped, a start waits for its save, and the run starts after', () => {
    const m = createMachine();
    expect(step(m, { t: 'edit', token: 1 }, 0)).toContainEqual({ t: 'save', n: 1 });
    expect(step(m, { t: 'start', token: 2 }, 0).filter(e => e.t === 'launch')).toEqual([]);
    expect(step(m, { t: 'edit', token: 3 }, 0)).toContainEqual({ t: 'reply', token: 3, reply: { kind: 'refused', words: 'Another change to this server is being saved.' } });
    const saved = step(m, { t: 'saved', n: 1 }, 0);
    expect(saved.map(e => e.t)).toEqual(['disarm', 'reply', 'launch', 'arm', 'changed']);
    expect(step(m, { t: 'edit', token: 4 }, 0)).toContainEqual({ t: 'reply', token: 4, reply: { kind: 'refused', words: 'Stop the server before changing it.' } });
  });

  it('a call for a tool that changed, or from another setup, is never sent', () => {
    const m = createMachine();
    step(m, { t: 'start', token: 1 }, 0);
    ready(m, 1, 'fb', 's1');
    const changed = step(m, { t: 'call', token: 2, tool: 't', args: {}, expect: { setup: 's1', tool: 'fa' } }, 0);
    expect(changed.filter(e => e.t === 'send')).toEqual([]);
    expect(changed).toContainEqual({ t: 'answer', call: 2, outcome: expect.objectContaining({ kind: 'error', reason: 'changed' }) });
    const otherSetup = step(m, { t: 'call', token: 3, tool: 't', args: {}, expect: { setup: 's2', tool: 'fb' } }, 0);
    expect(otherSetup.filter(e => e.t === 'send')).toEqual([]);
    expect(step(m, { t: 'call', token: 4, tool: 't', args: {}, expect: { setup: 's1', tool: 'fb' } }, 0).filter(e => e.t === 'send')).toHaveLength(1);
  });

  it('a storm of tool changes asks for one list at a time, holds calls, and drops an older answer', () => {
    const m = createMachine();
    step(m, { t: 'start', token: 1 }, 0);
    ready(m);
    const storm: Effect[] = [];
    for (let i = 0; i < 1000; i++) storm.push(...step(m, { t: 'tools-changed', gen: 1 }, 0));
    expect(storm.filter(e => e.t === 'list')).toEqual([{ t: 'list', gen: 1, n: 1 }]);
    expect(step(m, { t: 'call', token: 2, tool: 't', args: {} }, 0).filter(e => e.t === 'send')).toEqual([]);
    // The first answer comes, the change during it asks once more, and the call still waits.
    const again = step(m, { t: 'listed', gen: 1, n: 1, tools: tools('fb') }, 0);
    expect(again.filter(e => e.t === 'list')).toEqual([{ t: 'list', gen: 1, n: 2 }]);
    expect(again.filter(e => e.t === 'send')).toEqual([]);
    // A late copy of the first answer changes nothing.
    step(m, { t: 'listed', gen: 1, n: 1, tools: tools('fa') }, 0);
    expect(m.catalog.get('t')).toBe('fb');
    expect(step(m, { t: 'listed', gen: 1, n: 2, tools: tools('fb') }, 0).filter(e => e.t === 'send')).toHaveLength(1);
  });

  it('waiting lists are bounded', () => {
    const m = createMachine({ ...DEFAULT_LIMITS, maxWaiters: 3 });
    const fx: Effect[] = [];
    for (let t = 1; t <= 10_000; t++) fx.push(...step(m, { t: 'start', token: t }, 0));
    expect(m.starts.length).toBe(3);
    expect(fx.filter(e => e.t === 'reply')).toHaveLength(9_997);
  });
});
