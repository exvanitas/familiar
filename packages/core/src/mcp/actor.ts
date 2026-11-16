// The actor that owns one server: the only place its machine changes. Every command (start, stop, call,
// cancel, edit, remove, refresh) and every completion (a run started, a list answered, a save or a removal
// done) is a message, handled one at a time in arrival order through `step` (machine.ts). The effects it
// returns are done here: a session opened per generation, calls sent with a stop signal, timers armed on
// the injected clock, callers answered. Whatever the I/O sends back comes in as another message, tagged
// with its generation or its number, so the machine can drop what's late.
//
// The setup is held here too. An edit is admitted by the machine and counts only once saved; each run is
// started from the setup committed at its launch, which stays bound to that run.

import type { JournalClock } from '../journal/journal.ts';
import { CatalogError } from './catalog.ts';
import { createMachine, DEFAULT_LIMITS, step, type Effect, type Expect, type Input, type Limits, type Machine, type Phase } from './machine.ts';
import type { Session, SessionEvents } from './session.ts';
import type { CallOutcome, Failure, ListedTool, Reply } from './types.ts';

export interface ServerView {
  readonly phase: Phase;
  readonly tools: readonly ListedTool[];
  /** The last failure: why it stopped, why it's down, why a removal failed. */
  readonly failure?: Failure;
}

export interface ActorOptions<S> {
  /** The setup as saved when the actor is made. */
  readonly setup: S;
  /** What "always for this" binds to, for a setup. */
  readonly fingerprint: (setup: S) => string;
  /** Opens one run of this setup. */
  readonly open: (events: SessionEvents, setup: S) => Session;
  /** Saves an edited setup. It counts once this resolves. */
  readonly save: (setup: S) => Promise<void>;
  /** Removes what the exe, the fetch and the store keep for this server. */
  readonly forget: (setup: S) => Promise<void>;
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
  /** The tool as offered and the setup it came from: sent only if the server still offers exactly that. */
  readonly expect?: Expect;
  /** Checked at the moment the call is sent, after any wait in the queue: words to refuse it with, or
      undefined to send it. The person's choice is read here, not when the call was made. */
  readonly admit?: () => string | undefined;
}

export class ServerActor<S> {
  private readonly m: Machine;
  private readonly o: ActorOptions<S>;
  private readonly queue: Input[] = [];
  private draining = false;
  private token = 0;
  private committed: S;
  private pending: S | undefined;
  private readonly edits = new Map<number, S>();
  private readonly runs = new Map<number, { session: Session; setup: S }>();
  private readonly aborts = new Map<number, AbortController>();
  private readonly timers = new Map<string, () => void>();
  private readonly callers = new Map<number, (o: CallOutcome) => void>();
  private readonly admits = new Map<number, () => string | undefined>();
  private readonly repliers = new Map<number, (r: Reply) => void>();

  constructor(options: ActorOptions<S>) {
    this.o = options;
    this.committed = options.setup;
    this.m = createMachine(options.limits ?? DEFAULT_LIMITS);
  }

  get view(): ServerView {
    return { phase: this.m.phase, tools: this.m.tools, ...(this.m.failure ? { failure: this.m.failure } : {}) };
  }

  /** The setup as saved. */
  get setup(): S { return this.committed; }
  /** An edited setup being saved, if one is. */
  get pendingSetup(): S | undefined { return this.pending; }
  /** The setup the current run was started from, while there is one. */
  get runSetup(): S | undefined { return this.runs.get(this.m.gen)?.setup; }

  start(): Promise<Reply> { return this.command('start'); }
  stop(): Promise<Reply> { return this.command('stop'); }
  remove(): Promise<Reply> { return this.command('remove'); }
  refresh(): void { this.post({ t: 'refresh' }); }

  /** Admitted only while stopped or down; it counts once saved. */
  edit(setup: S): Promise<Reply> {
    const token = ++this.token;
    this.edits.set(token, setup);
    return new Promise<Reply>(resolve => {
      this.repliers.set(token, resolve);
      this.post({ t: 'edit', token });
    });
  }

  call(tool: string, args: unknown, options: CallOptions = {}): Promise<CallOutcome> {
    const signal = options.signal;
    // Stopped before it was made: answered at once, and nothing is sent.
    if (signal?.aborted) return Promise.resolve({ kind: 'stopped' });
    const token = ++this.token;
    return new Promise<CallOutcome>(resolve => {
      const onAbort = () => this.post({ t: 'cancel', call: token });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (options.admit) this.admits.set(token, options.admit);
      this.callers.set(token, outcome => {
        signal?.removeEventListener('abort', onAbort);
        this.admits.delete(token);
        resolve(outcome);
      });
      this.post({
        t: 'call', token, tool, args,
        ...(options.ms !== undefined ? { ms: options.ms } : {}),
        ...(options.expect ? { expect: options.expect } : {})
      });
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
        const setup = this.committed;
        const fingerprint = this.o.fingerprint(setup);
        const session = this.o.open({
          launched: () => this.post({ t: 'launched', gen }),
          ready: tools => this.post({ t: 'ready', gen, tools, setup: fingerprint }),
          toolsChanged: () => this.post({ t: 'tools-changed', gen }),
          closed: failure => {
            this.runs.delete(gen);
            this.post({ t: 'closed', gen, ...(failure ? { failure } : {}) });
          }
        }, setup);
        this.runs.set(gen, { session, setup });
        return;
      }
      case 'send': {
        // The last check, at the send itself: refused here, nothing reaches the server.
        const refused = this.admits.get(e.call)?.();
        if (refused !== undefined) {
          this.post({ t: 'result', gen: e.gen, call: e.call, outcome: { kind: 'error', reason: 'changed', words: refused } });
          return;
        }
        const session = this.runs.get(e.gen)?.session;
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
      case 'list': {
        const { gen, n } = e;
        const session = this.runs.get(gen)?.session;
        if (!session) return;
        session.list().then(
          tools => this.post({ t: 'listed', gen, n, tools }),
          (err: unknown) => this.post({ t: 'list-failed', gen, n, failure: err instanceof CatalogError ? err.failure : { kind: 'protocol', words: "The server couldn't list its tools." } })
        );
        return;
      }
      case 'halt':
        this.runs.get(e.gen)?.session.close();
        return;
      case 'save': {
        const n = e.n;
        const token = this.m.editing?.token;
        const setup = token === undefined ? undefined : this.edits.get(token);
        if (setup === undefined) return;
        this.pending = setup;
        this.o.save(setup).then(
          () => this.post({ t: 'saved', n }),
          () => this.post({ t: 'saved', n, failure: { kind: 'failed', words: "Familiar couldn't save the change. Try again." } })
        );
        return;
      }
      case 'forget': {
        const n = e.n;
        this.o.forget(this.committed).then(
          () => this.post({ t: 'forgotten', n }),
          () => this.post({ t: 'forgotten', n, failure: { kind: 'failed', words: "Familiar couldn't remove the server. Try removing it again." } })
        );
        return;
      }
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
        if (this.edits.has(e.token)) {
          // The edit's own answer: it counts only once saved.
          const edited = this.edits.get(e.token)!;
          this.edits.delete(e.token);
          if (e.reply.kind === 'edited') this.committed = edited;
          if (this.pending === edited) this.pending = undefined;
        }
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
