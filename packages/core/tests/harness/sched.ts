// The seeded scheduler (docs/mcp-design.md 7.2): every native answer, every timer and every action of the
// person is an event in one ready set, and at each step the seed picks the next one. After each event the
// code under test runs until it settles, so a run is a function of its seed.

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Ev {
  readonly label: string;
  /** Events of a lower rank are picked first among the ready ones, when any is ready (timers last). */
  readonly rank?: number;
  /** A timer's due time on the fake clock: timers fire earliest first, as a clock's do. */
  readonly due?: number;
  fire(): void;
}

/** Lets every promise chain the last event started run to quiescence. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await new Promise<void>((r) => setImmediate(r));
  }
}

export class Scheduler {
  readonly random: () => number;
  private readonly ready: Ev[] = [];
  /** One label per step, in order: the run's history, compared between a mutant and its twin. */
  readonly log: string[] = [];
  step = 0;
  now = 0;
  private readonly watchers: ((step: number) => void)[] = [];

  constructor(seed: number) {
    this.random = rng(seed);
  }

  add(ev: Ev): void {
    this.ready.push(ev);
  }

  private readonly later: { at: number; ev: Ev }[] = [];
  /** An event that becomes ready only `steps` steps from now (a person's action, spread over a run). */
  addLater(ev: Ev, steps: number): void {
    this.later.push({ at: this.step + steps, ev });
  }

  /** Called after every step, for the harness's own bookkeeping (mutation hits, checks). */
  onStep(w: (step: number) => void): void {
    this.watchers.push(w);
  }

  get pending(): number {
    return this.ready.length;
  }

  /** The fake clock's timers: an event that, when picked, moves time and fires. */
  timer(callback: () => void, ms: number): () => void {
    let live = true;
    const due = this.now + ms;
    this.add({ label: `timer:${ms}`, rank: 1, due, fire: () => {
      if (!live) return;
      this.now = Math.max(this.now, due);
      callback();
    } });
    return () => (live = false);
  }

  clock() {
    return { now: () => this.now, setTimer: (cb: () => void, ms: number) => this.timer(cb, ms) };
  }

  /** Runs until nothing is ready or the step bound. */
  async run(maxSteps: number): Promise<void> {
    await settle();
    while ((this.ready.length || this.later.length) && this.step < maxSteps) {
      for (let i = this.later.length - 1; i >= 0; i--) if (this.later[i]!.at <= this.step || !this.ready.length) this.ready.push(...this.later.splice(i, 1).map((l) => l.ev));
      if (!this.ready.length) continue;
      const lowest = Math.min(...this.ready.map((e) => e.rank ?? 0));
      const candidates = this.ready.map((e, i) => [e, i] as const).filter(([e]) => (e.rank ?? 0) === lowest);
      // Timers mostly wait for other work: picked only when nothing else is ready, or now and then.
      let pool = lowest === 0 && this.random() < 0.001 ? this.ready.map((e, i) => [e, i] as const) : candidates;
      // Among timers, only the earliest due may fire.
      const timers = pool.filter(([e]) => e.due !== undefined);
      if (timers.length) {
        const earliest = Math.min(...timers.map(([e]) => e.due!));
        pool = pool.filter(([e]) => e.due === undefined || e.due === earliest);
      }
      const [ev, i] = pool[Math.floor(this.random() * pool.length)]!;
      this.ready.splice(i, 1);
      this.step++;
      this.log.push(ev.label);
      ev.fire();
      await settle();
      for (const w of this.watchers) w(this.step);
    }
  }
}
