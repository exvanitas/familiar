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
// - Stop waits for the exe's answer and the exit, within Stop's own deadline; past it, or if the exe refuses,
//   the server may still be running, and says so.
// - One exchange per server (wire/exchange.ts).
// - Every lifecycle decision is the machine's (wire/lifecycle.ts): this reads its phase, and builds the facts
//   a start needs from the committed record.

import type { Owner, OwnedServer } from './owner.ts';
import type { ProcessPort } from './process.ts';
import { remoteHeaders } from './remote.ts';
import { processSetupOf, remoteTargetOf, setupFingerprint } from './setup.ts';
import type { Failure, ListedTool, Reply } from './types.ts';
import { LINK_LIMITS, ServerLink, type LinkClock, type LinkEvents, type LinkLimits, type NetPort, type Target } from './wire/link.ts';
import type { Reply as LcReply, StartFacts } from './wire/lifecycle.ts';

export type Phase = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';

export interface RuntimePorts {
  readonly processes: ProcessPort;
  readonly net: NetPort;
  readonly clock: LinkClock;
  readonly limits?: Partial<LinkLimits>;
}

export class ServerRuntime {
  readonly id: string;
  readonly link: ServerLink;
  private readonly owner: Owner;
  /** Hears a run's tool list, with whether that run is still this server's run; settles once it's saved. */
  private readonly onListed: (tools: readonly ListedTool[], current: () => boolean, run: string) => Promise<void> | void;
  private readonly portLimits: Partial<LinkLimits> | undefined;

  constructor(id: string, owner: Owner, ports: RuntimePorts, onChange: () => void, onListed: (tools: readonly ListedTool[], current: () => boolean, run: string) => Promise<void> | void, onPublished: (tools: readonly ListedTool[], launch: string) => void, hooks: { readonly transition?: LinkEvents['transition']; readonly exchange?: LinkEvents['exchange'] } = {}) {
    this.id = id;
    this.owner = owner;
    this.onListed = onListed;
    this.portLimits = ports.limits;
    this.link = new ServerLink(id, { net: ports.net, processes: ports.processes }, ports.clock, {
      changed: onChange,
      ended: () => onChange(),
      published: (_run, tools, launch) => onPublished(tools, launch),
      // The catalog write is an owner effect of its own (5.1); the start waits for it.
      listed: (run, tools) =>
        Promise.resolve(this.onListed(tools, () => this.link.current?.run === run, run)).then(
          () => 'saved' as const,
          () => 'failed' as const
        ),
      admit: () => {
        const a = this.owner.admit('start', { start: true });
        return 'release' in a ? a : { words: a.ok ? '' : a.words };
      },
      // The committed record now, for the machine's relaunch decision: nothing here decides.
      record: () => {
        const now = this.owner.server(this.id);
        return { enabled: !!now?.enabled && !now.removing, launch: now && !now.removing ? setupFingerprint(now.setup) : '' };
      },
      ...(hooks.transition ? { transition: hooks.transition } : {}),
      ...(hooks.exchange ? { exchange: hooks.exchange } : {})
    }, { ...LINK_LIMITS, ...linkLimitsOf(owner.server(id)), ...ports.limits });
  }

  get phase(): Phase {
    const p = this.link.phase;
    return p === 'held' ? 'failed' : p;
  }
  get failure(): Failure | undefined {
    return this.link.failure;
  }
  /** The run's catalog while Ready. */
  get tools(): readonly ListedTool[] {
    return this.phase === 'ready' ? (this.link.current?.tools ?? []) : [];
  }
  /** Tools the run listed but doesn't offer, with why. */
  get notOffered(): readonly { readonly name: string; readonly reason: string }[] {
    return this.link.current?.notOffered ?? [];
  }
  /** The run id and its launch while Ready. */
  get run(): { readonly id: string; readonly launch: string } | undefined {
    const c = this.link.current;
    return this.phase === 'ready' && c ? { id: c.run, launch: c.launch } : undefined;
  }
  /** The current run's id, while Ready. */
  get runNow(): string | undefined {
    return this.run?.id;
  }

  /** The record's facts for a start, read in the same step as the admission (5.4), its target and its
      limits. It writes nothing: a start the machine refuses leaves every run as it was. */
  private prepare(auto: boolean): { readonly facts: Partial<StartFacts>; readonly target?: Target; readonly launch?: string; readonly limits?: LinkLimits } {
    const record: OwnedServer | undefined = this.owner.server(this.id);
    if (!record) return { facts: { record: this.owner.unreadableServers().includes(this.id) ? 'unreadable' : 'missing' } };
    if (record.removing) return { facts: { record: 'removing' } };
    if (auto && !record.enabled) return { facts: { record: 'disabled' } };
    const setup = record.setup;
    if (setup.kind === 'remote' && setup.transport === 'sse') return { facts: { record: 'sse' } };
    try {
      const target: Target = setup.kind === 'local' ? { where: 'local', setup: processSetupOf(setup) } : { where: 'remote', address: setup.address ?? '', url: setup.url, headers: Object.entries(remoteHeaders(remoteTargetOf(setup))) };
      // The committed record's limits, read in the same step: the run keeps them, whatever is saved later.
      const limits: LinkLimits = { ...LINK_LIMITS, ...linkLimitsOf(record), ...this.portLimits };
      return { facts: { record: 'ok' }, target, launch: setupFingerprint(setup), limits };
    } catch {
      return { facts: { record: 'unlaunchable' } };
    }
  }

  /**
   * Starts the committed record. Admitted only from Stopped or Failed, and by the owner (the machine's
   * facts). An automatic start (`auto`, starting with the app) also needs the record enabled, and so does
   * its modern relaunch.
   */
  async start(options: { readonly auto?: boolean } = {}): Promise<Reply> {
    const p = this.prepare(!!options.auto);
    const placeholder: Target = { where: 'remote', address: '', url: '', headers: [] };
    const r = await this.link.startReply(p.target ?? placeholder, p.launch ?? '', options.auto ? 'auto' : 'start', p.facts, p.limits);
    return replyOf(r);
  }

  /** Test: an admitted start, the tool list, then its own stop. Only from Stopped or Failed. */
  test(): ReturnType<ServerLink['test']> {
    const p = this.prepare(false);
    const placeholder: Target = { where: 'remote', address: '', url: '', headers: [] };
    return this.link.test(p.target ?? placeholder, p.launch ?? '', p.facts, p.limits);
  }

  /** Stops the run only if it is still `run`: never a run started since. */
  async stopRun(run: string): Promise<Reply> {
    if (this.link.current?.run !== run) return { kind: 'stopped' };
    return this.stop();
  }

  /** Stops the run and waits for its end, or for Stop's own deadline. */
  async stop(): Promise<Reply> {
    return replyOf(await this.link.stopReply());
  }
}

/** The machine's answer as the client's Reply. */
function replyOf(r: LcReply): Reply {
  switch (r.kind) {
    case 'ready':
      return { kind: 'ready' };
    case 'stopped':
      return { kind: 'stopped' };
    case 'failed':
      return { kind: 'failed', failure: r.failure };
    case 'refused':
      return { kind: 'refused', words: r.words };
    case 'tested':
      return { kind: 'stopped' };
  }
}

function linkLimitsOf(record: OwnedServer | undefined): Partial<LinkLimits> {
  const initMs = record?.limits.initMs;
  return initMs === undefined ? {} : { startMs: Math.min(300_000, Math.max(5_000, initMs)) };
}
