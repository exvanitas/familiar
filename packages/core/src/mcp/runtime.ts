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
import { LINK_LIMITS, ServerLink, type LinkClock, type LinkLimits, type NetPort, type Target } from './wire/link.ts';

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
  readonly id: string;
  readonly link: ServerLink;
  private readonly owner: Owner;
  private readonly onChange: () => void;
  /** Hears a run's tool list, with whether that run is still this server's run; settles once it's saved. */
  private readonly onListed: (tools: readonly ListedTool[], current: () => boolean) => Promise<void> | void;

  constructor(id: string, owner: Owner, ports: RuntimePorts, onChange: () => void, onListed: (tools: readonly ListedTool[], current: () => boolean) => Promise<void> | void) {
    this.id = id;
    this.owner = owner;
    this.onChange = onChange;
    this.onListed = onListed;
    const limits: LinkLimits = { ...LINK_LIMITS, ...linkLimitsOf(owner.server(id)), ...ports.limits };
    this.link = new ServerLink(id, { net: ports.net, processes: ports.processes }, ports.clock, {
      ended: (run, failure) => {
        if (run !== this.runId) return;
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

  /** Starts the committed record. Admitted only from Stopped or Failed, and by the owner. */
  async start(): Promise<Reply> {
    if (this.phaseNow !== 'stopped' && this.phaseNow !== 'failed') return { kind: 'refused', words: this.phaseNow === 'ready' ? 'It is already running.' : `It is ${this.phaseNow}.` };
    // The launch is read in the same step as the admission.
    const record: OwnedServer | undefined = this.owner.server(this.id);
    if (!record) return { kind: 'refused', words: this.owner.unreadableServers().includes(this.id) ? "Familiar can't read this server's saved setup, so it won't start it." : 'No server is saved with that id.' };
    if (record.removing) return { kind: 'refused', words: 'It is being removed.' };
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
    let released = false;
    const launched = () => {
      if (!released) {
        released = true;
        admitted.release();
      }
    };
    let r;
    // Everything after the admission is inside this block, so a throw anywhere still releases the owner.
    try {
      this.set('starting');
      r = await this.link.start(target, launch, { launched });
      // A modern-only stdio server that ended its process after refusing the legacy opening: one more start
      // of the same setup, readmitted by the owner, era fixed to modern (3.9).
      if (!r.ok && r.relaunch === 'modern' && (this.phaseNow as Phase) === 'starting') {
        const again = this.owner.admit('start', { start: true });
        if (!('release' in again)) r = { ok: false as const, failure: { kind: 'busy' as const, words: 'Familiar is saving another change. Press Start again.' } };
        else if (this.owner.server(this.id) !== record && JSON.stringify(this.owner.server(this.id)?.setup) !== JSON.stringify(setup)) {
          again.release();
          r = { ok: false as const, failure: { kind: 'busy' as const, words: 'The setup changed. Press Start again.' } };
        } else {
          let once = false;
          r = await this.link.start(target, launch, { era: 'modern', launched: () => (once ? undefined : ((once = true), again.release())) });
        }
      }
    } finally {
      launched();
    }
    if ((this.phaseNow as Phase) !== 'starting') {
      if (r.ok) await this.link.stop();
      return { kind: 'stopped' };
    }
    if (!r.ok) {
      this.set('failed', r.failure);
      return { kind: 'failed', failure: r.failure };
    }
    const run = r.run;
    this.runId = run;
    this.set('ready');
    // The catalog write is an owner effect of its own (5.1): Ready is answered once it has settled, so the
    // next start (startEnabled's, say) finds the owner free.
    await this.onListed(r.tools, () => run === this.runId);
    return { kind: 'ready' };
  }

  /** Stops the run and waits for its end. */
  async stop(): Promise<Reply> {
    if (this.phaseNow === 'stopped' || this.phaseNow === 'failed') return { kind: 'stopped' };
    if (this.phaseNow !== 'ready' && this.phaseNow !== 'starting') return { kind: 'refused', words: `It is ${this.phaseNow}.` };
    this.set('stopping');
    await this.link.stop();
    this.runId = undefined;
    this.set('stopped');
    return { kind: 'stopped' };
  }

  /** Test's own start failed: back to Stopped, as it was. */
  settle(): void {
    if (this.phaseNow === 'failed') this.set('stopped');
  }
}

function linkLimitsOf(record: OwnedServer | undefined): Partial<LinkLimits> {
  const initMs = record?.limits.initMs;
  return initMs === undefined ? {} : { startMs: Math.min(300_000, Math.max(5_000, initMs)) };
}
