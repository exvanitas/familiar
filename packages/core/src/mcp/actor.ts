// The actor that owns one server: the only place its machine changes. Every command and every event is a
// message, handled one at a time in arrival order through `step` (machine.ts). The effects it returns are
// done here: a session opened per generation, calls sent with a stop signal, timers armed on the injected
// clock, callers answered. Whatever the I/O sends back comes in as another message, tagged with its
// generation, so the machine can drop what's late.

import type { JournalClock } from '../journal/journal.ts';
import { createMachine, DEFAULT_LIMITS, step, type Effect, type Input, type Limits, type Machine, type Phase } from './machine.ts';
import type { Session, SessionEvents } from './session.ts';
import type { CallOutcome, Failure, ListedTool, Reply } from './types.ts';

export interface ServerView {
  readonly phase: Phase;
  readonly tools: readonly ListedTool[];
  /** The last failure: why it stopped, why it's down, why a removal failed. */
  readonly failure?: Failure;
}

export interface ActorOptions {
  /** Opens one run. */
  readonly open: (events: SessionEvents) => Session;
  /** Removes what the exe or the fetch keeps for this server: its approval or its address. */
  readonly forget: () => Promise<void>;
  readonly clock: Pick<JournalClock, 'now' | 'setTimer'>;
  readonly limits?: Limits;
  /** Hears every change of phase, tools or failure. */
  readonly onChange?: (view: ServerView) => void;
}

export interface CallOptions {
  /** The call's deadline in ms. The server's own default when absent. */
  readonly ms?: number;
  /** Stops the call, as the Stop button does. */
  readonly signal?: AbortSignal;
}

export class ServerActor {
  private readonly m: Machine;
  private readonly queue: Input[] = [];
  private draining = false;
  private token = 0;
  private readonly sessions = new Map<number, Session>();
  private readonly aborts = new Map<number, AbortController>();
  private readonly timers = new Map<string, () => void>();
  private readonly callers = new Map<number, (o: CallOutcome) => void>();
  private readonly repliers = new Map<number, (r: Reply) => void>();

  private readonly o: ActorOptions;

  constructor(options: ActorOptions) {
    this.o = options;
    this.m = createMachine(options.limits ?? DEFAULT_LIMITS);
  }

  get view(): ServerView {
    return { phase: this.m.phase, tools: this.m.tools, ...(this.m.failure ? { failure: this.m.failure } : {}) };
  }

  start(): Promise<Reply> { return this.command('start'); }
  stop(): Promise<Reply> { return this.command('stop'); }
  remove(): Promise<Reply> { return this.command('remove'); }
  refresh(): void { this.post({ t: 'refresh' }); }

  call(tool: string, args: unknown, options: CallOptions = {}): Promise<CallOutcome> {
    const token = ++this.token;
    const signal = options.signal;
    return new Promise<CallOutcome>(resolve => {
      const onAbort = () => this.post({ t: 'cancel', call: token });
      this.callers.set(token, outcome => {
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      });
      this.post({ t: 'call', token, tool, args, ...(options.ms !== undefined ? { ms: options.ms } : {}) });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private command(t: 'start' | 'stop' | 'remove'): Promise<Reply> {
    const token = ++this.token;
    return new Promise<Reply>(resolve => {
      this.repliers.set(token, resolve);
      this.post({ t, token });
    });
  }

  /** One queue: a message posted while another is handled waits its turn. */
  private post(input: Input): void {
    this.queue.push(input);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        for (const e of step(this.m, next, this.o.clock.now())) this.effect(e);
      }
    } finally {
      this.draining = false;
    }
  }

  private effect(e: Effect): void {
    switch (e.t) {
      case 'launch': {
        const gen = e.gen;
        const session = this.o.open({
          launched: () => this.post({ t: 'launched', gen }),
          ready: tools => this.post({ t: 'ready', gen, tools }),
          toolsChanged: () => this.post({ t: 'tools-changed', gen }),
          closed: failure => {
            this.sessions.delete(gen);
            this.post({ t: 'closed', gen, ...(failure ? { failure } : {}) });
          }
        });
        this.sessions.set(gen, session);
        return;
      }
      case 'send': {
        const session = this.sessions.get(e.gen);
        const abort = new AbortController();
        this.aborts.set(e.call, abort);
        if (!session) return;
        void session.call(e.tool, e.args, abort.signal).then(outcome => {
          this.aborts.delete(e.call);
          if (outcome) this.post({ t: 'result', gen: e.gen, call: e.call, outcome });
        });
        return;
      }
      case 'abort':
        this.aborts.get(e.call)?.abort();
        this.aborts.delete(e.call);
        return;
      case 'list':
        void this.sessions.get(e.gen)?.list().then(tools => this.post({ t: 'listed', gen: e.gen, tools }), () => {});
        return;
      case 'halt':
        this.sessions.get(e.gen)?.close();
        return;
      case 'forget':
        this.o.forget().then(
          () => this.post({ t: 'forgotten' }),
          () => this.post({ t: 'forgotten', failure: { kind: 'failed', words: "Familiar couldn't remove the server. Try removing it again." } })
        );
        return;
      case 'arm': {
        this.timers.get(e.key)?.();
        const key = e.key;
        const cancel = this.o.clock.setTimer(() => {
          this.timers.delete(key);
          this.post({ t: 'timer', key });
        }, Math.max(0, e.at - this.o.clock.now()), { background: false });
        this.timers.set(key, cancel ?? (() => {}));
        return;
      }
      case 'disarm':
        this.timers.get(e.key)?.();
        this.timers.delete(e.key);
        return;
      case 'answer': {
        const answer = this.callers.get(e.call);
        this.callers.delete(e.call);
        this.aborts.delete(e.call);
        answer?.(e.outcome);
        return;
      }
      case 'reply': {
        const reply = this.repliers.get(e.token);
        this.repliers.delete(e.token);
        reply?.(e.reply);
        return;
      }
      case 'changed':
        this.o.onChange?.(this.view);
        return;
    }
  }
}
