// One saved server's runs (docs/mcp-design.md 5.4). Its record is the owner's (owner.ts); this holds only
// what a run is.
//
//   Stopped -> Starting -> Ready -> Stopping -> Stopped, and Failed from Starting or Ready.
//
// - No automatic restart: a crash ends the run, calls in flight are answered "interrupted, it may have
//   partly run", and the server goes to Failed with the reason and its last output.
// - A start is admitted by the owner, and reads the committed record in that same synchronous step. The
//   exe's native start counts as the owner's effect in flight until it answers.
// - A call while not Ready is refused "not running"; a call is never sent again on any path.
// - Stop waits for the exe's answer and the exit, with no deadline of its own.
// - One exchange per server (wire/exchange.ts).

import type { Owner, OwnedServer } from './owner.ts';
import type { ProcessPort } from './process.ts';
import { remoteHeaders } from './remote.ts';
import { processSetupOf, remoteTargetOf, setupFingerprint } from './setup.ts';
import type { Failure, ListedTool, Reply } from './types.ts';
import { LINK_LIMITS, ServerLink, STOP_REFUSED, type LinkClock, type LinkLimits, type NetPort, type Target } from './wire/link.ts';
import { mutant } from '../mutations.ts';

export type Phase = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';

export interface RuntimePorts {
  readonly processes: ProcessPort;
  readonly net: NetPort;
  readonly clock: LinkClock;
  readonly limits?: Partial<LinkLimits>;
}

export class ServerRuntime {
  private phaseNow: Phase = 'stopped';
  private failureNow: Failure | undefined;
  private runId: string | undefined;
  /** The current start's token. A start's continuation acts only while its token is current: a Stop, or a
      later start, makes it stale, so it can never take a later start's Starting for its own. */
  private startToken = 0;
  /** The last run that ended before this runtime knew it was its run: a start then answers for it. */
  private endedEarly: { readonly run: string; readonly failure: Failure } | undefined;
  readonly id: string;
  readonly link: ServerLink;
  private readonly owner: Owner;
  private readonly onChange: () => void;
  /** Hears a run's tool list, with whether that run is still this server's run; settles once it's saved. */
  private readonly onListed: (tools: readonly ListedTool[], current: () => boolean) => Promise<void> | void;

  /** The link's limits: one object the link reads at each use, set again from the record at each Start. */
  private readonly limits: { -readonly [K in keyof LinkLimits]: LinkLimits[K] };
  private readonly portLimits: Partial<LinkLimits> | undefined;

  constructor(id: string, owner: Owner, ports: RuntimePorts, onChange: () => void, onListed: (tools: readonly ListedTool[], current: () => boolean) => Promise<void> | void) {
    this.id = id;
    this.owner = owner;
    this.onChange = onChange;
    this.onListed = onListed;
    this.portLimits = ports.limits;
    const limits = { ...LINK_LIMITS, ...linkLimitsOf(owner.server(id)), ...ports.limits };
    this.limits = limits;
    this.link = new ServerLink(id, { net: ports.net, processes: ports.processes }, ports.clock, {
      ended: (run, failure) => {
        if (run !== this.runId) {
          this.endedEarly = { run, failure };
          return;
        }
        this.runId = undefined;
        if (this.phaseNow === 'stopping') return;
        this.set('failed', failure);
      },
      listed: (run, tools) => {
        if (run === this.runId) void this.onListed(tools, () => run === this.runId);
      }
    }, limits);
  }

  get phase(): Phase {
    return this.phaseNow;
  }
  get failure(): Failure | undefined {
    return this.failureNow;
  }
  /** The run's catalog while Ready. */
  get tools(): readonly ListedTool[] {
    return this.phaseNow === 'ready' ? (this.link.current?.tools ?? []) : [];
  }
  /** Tools the run listed but doesn't offer, with why. */
  get notOffered(): readonly { readonly name: string; readonly reason: string }[] {
    return this.link.current?.notOffered ?? [];
  }
  /** The run id and its launch while Ready. */
  get run(): { readonly id: string; readonly launch: string } | undefined {
    const c = this.link.current;
    return this.phaseNow === 'ready' && c ? { id: c.run, launch: c.launch } : undefined;
  }

  private set(phase: Phase, failure?: Failure): void {
    this.phaseNow = phase;
    this.failureNow = failure;
    this.onChange();
  }

  /**
   * Starts the committed record. Admitted only from Stopped or Failed, and by the owner. An automatic
   * start (`auto`, starting with the app) also needs the committed record enabled, read in the same step,
   * and so does its modern relaunch: a server turned off meanwhile isn't started.
   */
  async start(options: { readonly auto?: boolean } = {}): Promise<Reply> {
    if (this.phaseNow !== 'stopped' && this.phaseNow !== 'failed') return { kind: 'refused', words: this.phaseNow === 'ready' ? 'It is already running.' : `It is ${this.phaseNow}.` };
    // The launch is read in the same step as the admission.
    const record: OwnedServer | undefined = this.owner.server(this.id);
    if (!record) return { kind: 'refused', words: this.owner.unreadableServers().includes(this.id) ? "Familiar can't read this server's saved setup, so it won't start it." : 'No server is saved with that id.' };
    if (record.removing) return { kind: 'refused', words: 'It is being removed.' };
    if (options.auto && !record.enabled) return { kind: 'refused', words: 'It is turned off.' };
    const setup = record.setup;
    if (setup.kind === 'remote' && setup.transport === 'sse') return { kind: 'failed', failure: { kind: 'protocol', words: "Legacy SSE servers are not supported. Use the server's Streamable HTTP address." } };
    // The target is built before the admission, in the same synchronous step: a record that can't be
    // launched fails here and holds nothing.
    let target: Target;
    let launch: string;
    try {
      target = setup.kind === 'local' ? { where: 'local', setup: processSetupOf(setup) } : { where: 'remote', address: setup.address ?? '', url: setup.url, headers: Object.entries(remoteHeaders(remoteTargetOf(setup))) };
      launch = setupFingerprint(setup);
    } catch {
      const failure: Failure = { kind: 'failed', words: "Familiar can't read this server's saved setup, so it won't start it." };
      this.set('failed', failure);
      return { kind: 'failed', failure };
    }
    const admitted = this.owner.admit('start', { start: true });
    if (!('release' in admitted)) return { kind: 'refused', words: admitted.ok ? '' : admitted.words };
    // The committed record's limits, read in the same step: a handshake limit set since applies now.
    Object.assign(this.limits, LINK_LIMITS, linkLimitsOf(record), this.portLimits);
    const mine = ++this.startToken;
    const current = () => this.startToken === mine && this.phaseNow === 'starting';
    let released = false;
    const launched = () => {
      if (!released) {
        released = true;
        admitted.release();
      }
    };
    let r;
    let turnedOff = false;
    // Everything after the admission is inside this block, so a throw anywhere still releases the owner.
    try {
      this.set('starting');
      r = await this.link.start(target, launch, { launched });
      // A modern-only stdio server that ended its process after refusing the legacy opening: one more start
      // of the same setup, readmitted by the owner, era fixed to modern (3.9).
      if (!r.ok && r.relaunch === 'modern' && current()) {
        const now = this.owner.server(this.id);
        const again = this.owner.admit('start', { start: true });
        if (!('release' in again)) r = { ok: false as const, failure: { kind: 'busy' as const, words: 'Familiar is saving another change. Press Start again.' } };
        else if (options.auto && !now?.enabled) {
          again.release();
          turnedOff = true;
        } else if (JSON.stringify(now?.setup) !== JSON.stringify(setup)) {
          again.release();
          r = { ok: false as const, failure: { kind: 'busy' as const, words: 'The setup changed. Press Start again.' } };
        } else {
          let once = false;
          const releaseAgain = () => (once ? undefined : ((once = true), again.release()));
          try {
            r = await this.link.start(target, launch, { era: 'modern', launched: releaseAgain });
          } finally {
            releaseAgain();
          }
        }
      }
    } finally {
      launched();
    }
    if (turnedOff && current()) {
      // An automatic start whose server was turned off before its relaunch: Stopped, as it was asked.
      this.set('stopped');
      return { kind: 'stopped' };
    }
    if (!current()) {
      // Stopped meanwhile. Its run, if it got one and it's still the link's, is ended here; a later
      // start's run is never touched.
      if (r.ok && this.link.current?.run === r.run) await this.link.stop();
      return { kind: 'stopped' };
    }
    if (!r.ok) {
      this.set('failed', r.failure);
      return { kind: 'failed', failure: r.failure };
    }
    const run = r.run;
    // A run that ended before this start knew its id (its exit right behind the last reply) is never shown
    // Ready: the start fails with the run's own words.
    const early = this.endedEarly?.run === run ? this.endedEarly.failure : this.link.current?.run !== run ? { kind: 'exited' as const, words: 'The server stopped as it started.' } : undefined;
    if (early) {
      this.set('failed', early);
      return { kind: 'failed', failure: early };
    }
    this.runId = run;
    this.set('ready');
    // The catalog write is an owner effect of its own (5.1): Ready is answered once it has settled, so the
    // next start (startEnabled's, say) finds the owner free. A write that fails stops the run it was for:
    // a start never answers by throwing, and never leaves a run going that it didn't answer ready.
    try {
      await this.onListed(r.tools, () => run === this.runId);
    } catch {
      if (this.runId === run) await this.stop();
      return { kind: 'failed', failure: { kind: 'failed', words: "Familiar couldn't save the server's tool list, so it was stopped. Try again." } };
    }
    // Stopped, or stopped and started again, while the write was saving: this start's run is over, and
    // it says so; it never answers for another run.
    if ((this.startToken !== mine || this.runId !== run) && !(__FAMILIAR_MUTATIONS__ && mutant('ready-after-stop'))) {
      // No Stop, no later start: the run ended by itself while its write saved (a crash), and the start
      // answers with that failure's own words.
      if (this.startToken === mine && this.phaseNow === 'failed' && this.failureNow) return { kind: 'failed', failure: this.failureNow };
      return { kind: 'stopped' };
    }
    return { kind: 'ready' };
  }

  /** The current run's id, while Ready. */
  get runNow(): string | undefined {
    return this.phaseNow === 'ready' ? this.runId : undefined;
  }

  /** Stops the run only if it is still `run`: never a run started since. */
  async stopRun(run: string): Promise<Reply> {
    if (this.runId !== run) return { kind: 'stopped' };
    return this.stop();
  }

  /** Stops the run and waits for its end. */
  async stop(): Promise<Reply> {
    // Cleanup the exe refused for good: the words say a restart is the way back.
    const held = this.link.held;
    if (held && (this.phaseNow === 'stopped' || this.phaseNow === 'failed')) return { kind: 'failed', failure: held };
    if (this.phaseNow === 'stopped' || this.phaseNow === 'failed') return { kind: 'stopped' };
    if (this.phaseNow !== 'ready' && this.phaseNow !== 'starting') return { kind: 'refused', words: `It is ${this.phaseNow}.` };
    this.startToken++;
    this.set('stopping');
    const how = await this.link.stop();
    this.runId = undefined;
    if (how === 'refused') {
      this.set('failed', STOP_REFUSED);
      return { kind: 'failed', failure: STOP_REFUSED };
    }
    this.set('stopped');
    return { kind: 'stopped' };
  }

  /** The token of the start made last: read right after calling `start`, it names that start. */
  get token(): number {
    return this.startToken;
  }

  /** Test's own start failed: back to Stopped, as it was. Only while that start is still the latest: a
      start made since keeps its own outcome, a failure included. */
  settle(token: number): void {
    if (token !== this.startToken && !(__FAMILIAR_MUTATIONS__ && mutant('stale-settle'))) return;
    if (this.phaseNow === 'failed') this.set('stopped');
  }
}

function linkLimitsOf(record: OwnedServer | undefined): Partial<LinkLimits> {
  const initMs = record?.limits.initMs;
  return initMs === undefined ? {} : { startMs: Math.min(300_000, Math.max(5_000, initMs)) };
}
