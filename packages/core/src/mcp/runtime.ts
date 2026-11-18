// One saved server: its record and its runs (docs/mcp-design.md 5.4). It replaces the r20 actor and its
// machine, which queued calls behind a start: here nothing waits in line.
//
//   Stopped -> Starting -> Ready -> Stopping -> Stopped, and Failed from Starting or Ready.
//
// - No automatic restart: a crash ends the run, calls in flight are answered "interrupted, it may have
//   partly run", and the server goes to Failed with the reason and its last output.
// - A start reads the committed record in the same synchronous step as its admission. Edits need Stopped.
// - A call while not Ready is refused "not running"; a call is never sent again on any path.
// - Stop waits for the exe's answer and the exit, with no deadline of its own.
// - One exchange per server (wire/exchange.ts), and Test only while Stopped.
//
// Record changes stand in here until phase 4's owner (5.1): one at a time per server, a second refused
// busy at once, each fenced in the store's own transaction (saved.ts).

import type { SettingsStore } from '../settings/store.ts';
import type { ProcessPort } from './process.ts';
import { remoteHeaders } from './remote.ts';
import { addServer, deleteServer, saveServer, type SavedServer } from './saved.ts';
import { processSetupOf, remoteTargetOf, secretRefs, setupFingerprint } from './setup.ts';
import type { Failure, ListedTool, Reply } from './types.ts';
import { LINK_LIMITS, ServerLink, type LinkClock, type LinkLimits, type NetPort, type Target } from './wire/link.ts';

export type Phase = 'adding' | 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed' | 'removing' | 'removed';

export interface RuntimePorts {
  readonly store: SettingsStore;
  readonly processes: ProcessPort;
  readonly net: NetPort;
  readonly addresses: { add(spec: { url: string; label: string }): Promise<{ id: string }>; remove(id: string): Promise<void> };
  readonly secrets: { delete(ref: string): Promise<void> };
  readonly clock: LinkClock;
  readonly limits?: Partial<LinkLimits>;
}

const BUSY: Reply = { kind: 'refused', words: 'Saving another change. Try again in a moment.' };

export class ServerRuntime {
  private record: SavedServer;
  private phaseNow: Phase;
  private failureNow: Failure | undefined;
  private changing = false;
  /** The tools-seen save, which no one waits for: a person's change goes after it. */
  private touching: Promise<unknown> = Promise.resolve();
  private writes = 0;
  private readonly baseRev: number;
  private runId: string | undefined;
  readonly link: ServerLink;
  private readonly ports: RuntimePorts;
  private readonly onChange: () => void;
  /** Hears a run's catalog after a refresh, to save the tools last seen. */
  private readonly onListed: (tools: readonly ListedTool[]) => void;

  constructor(record: SavedServer, adding: boolean, ports: RuntimePorts, onChange: () => void, onListed: (tools: readonly ListedTool[]) => void) {
    this.record = record;
    this.baseRev = record.rev;
    this.phaseNow = adding ? 'adding' : 'stopped';
    this.ports = ports;
    this.onChange = onChange;
    this.onListed = onListed;
    const limits: LinkLimits = { ...LINK_LIMITS, ...linkLimitsOf(record), ...ports.limits };
    this.link = new ServerLink(record.setup.id, { net: ports.net, processes: ports.processes }, ports.clock, {
      ended: (run, failure) => {
        if (run !== this.runId) return;
        this.runId = undefined;
        if (this.phaseNow === 'stopping' || this.phaseNow === 'removing' || this.phaseNow === 'removed') return;
        this.set('failed', failure);
      },
      listed: (run, tools) => {
        if (run === this.runId) this.onListed(tools);
      }
    }, limits);
  }

  get setup(): SavedServer {
    return this.record;
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
  /** Tools the run listed but doesn't offer, with why (a modern header declaration that breaks the rules). */
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

  /* ---------- runs ---------- */

  /** Starts the committed record. Admitted only from Stopped or Failed, with no change being saved. */
  async start(): Promise<Reply> {
    if (this.phaseNow !== 'stopped' && this.phaseNow !== 'failed') return { kind: 'refused', words: this.phaseNow === 'ready' ? 'It is already running.' : `It is ${this.phaseNow}.` };
    if (this.changing) return BUSY;
    // The launch is read in this same step.
    const record = this.record;
    const setup = record.setup;
    const target: Target = setup.kind === 'local' ? { where: 'local', setup: processSetupOf(setup) } : { where: 'remote', address: setup.address ?? '', url: setup.url, headers: Object.entries(remoteHeaders(remoteTargetOf(setup))) };
    if (setup.kind === 'remote' && setup.transport === 'sse') return { kind: 'failed', failure: { kind: 'protocol', words: 'Legacy SSE servers are not supported. Use the server\'s Streamable HTTP address.' } };
    this.set('starting');
    let r = await this.link.start(target, setupFingerprint(setup));
    // A modern-only stdio server that ended its process after refusing the legacy opening: one more start
    // of the same setup, readmitted here (the committed launch, no change in flight), era fixed to modern.
    if (!r.ok && r.relaunch === 'modern' && (this.phaseNow as Phase) === 'starting') {
      if (this.changing || this.record !== record) r = { ok: false, failure: { kind: 'busy', words: 'Familiar is saving another change. Press Start again.' } };
      else r = await this.link.start(target, setupFingerprint(setup), { era: 'modern' });
    }
    if ((this.phaseNow as Phase) !== 'starting') {
      // Stopped or removed while starting: the run was ended there.
      if (r.ok) await this.link.stop();
      return { kind: 'stopped' };
    }
    if (!r.ok) {
      this.set('failed', r.failure);
      return { kind: 'failed', failure: r.failure };
    }
    this.runId = r.run;
    this.set('ready');
    this.onListed(r.tools);
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

  /** The tool list again, while Ready. A failed walk ends the run. */
  async refresh(): Promise<readonly ListedTool[] | Failure> {
    if (this.phaseNow !== 'ready') return { kind: 'failed', words: 'The server is not running.' };
    return this.link.list();
  }

  /* ---------- the record (a stand-in for 5.1's owner) ---------- */

  /** One change at a time: a second is refused at once. */
  private async change<T>(work: () => Promise<T>): Promise<T | Reply> {
    if (this.changing) return BUSY;
    this.changing = true;
    try {
      await this.touching;
      return await work();
    } finally {
      this.changing = false;
    }
  }

  /** Saves the tools last seen, after any change in flight. Never refused, never waited on. */
  touch(change: (r: SavedServer) => SavedServer): void {
    const run = async () => {
      while (this.changing) await new Promise((r) => setTimeout(r, 5));
      if (this.phaseNow === 'removing' || this.phaseNow === 'removed' || this.phaseNow === 'adding') return;
      await this.save(change(this.record)).catch(() => {});
      this.onChange();
    };
    this.touching = this.touching.then(run, run);
  }

  /** Test's own start failed: back to Stopped, as it was. */
  settle(): void {
    if (this.phaseNow === 'failed') this.set('stopped');
  }

  private async save(next: SavedServer): Promise<void> {
    const rev = this.baseRev + ++this.writes;
    if (!(await saveServer(this.ports.store, { ...next, rev }))) throw new Error('A newer record is saved.');
    this.record = { ...next, rev };
  }

  /** The add: a remote server's address first (the exe's dialog), then the first record. */
  async register(sharing: (address: string) => string | undefined): Promise<Reply> {
    const r = await this.change(async (): Promise<Reply> => {
      let setup = this.record.setup;
      try {
        if (setup.kind === 'remote') {
          const address = await this.ports.addresses.add({ url: setup.url, label: setup.label });
          const other = sharing(address.id);
          if (other) return { kind: 'refused', words: `Another server, ${other}, already uses this address. Familiar keeps one server per address.` };
          setup = { ...setup, address: address.id };
        }
        const added = { ...this.record, setup };
        if (!(await addServer(this.ports.store, added))) return { kind: 'refused', words: 'A server with this id is already saved.' };
        this.record = added;
      } catch (e) {
        return { kind: 'failed', failure: { kind: 'failed', words: e instanceof Error ? e.message : 'The server could not be added.' } };
      }
      this.set('stopped');
      return { kind: 'added' };
    });
    if (r.kind !== 'added') this.set('removed');
    return r as Reply;
  }

  /** A change of the setup, admitted only while Stopped or Failed. Dropped secrets are deleted after. */
  async edit(change: (r: SavedServer) => SavedServer): Promise<Reply> {
    if (this.phaseNow !== 'stopped' && this.phaseNow !== 'failed') return { kind: 'refused', words: 'Stop the server before changing it.' };
    return (await this.change(async (): Promise<Reply> => {
      const before = this.record;
      try {
        await this.save(change(before));
        for (const ref of secretRefs(before.setup).filter((x) => !secretRefs(this.record.setup).includes(x))) await this.ports.secrets.delete(ref);
      } catch (e) {
        return { kind: 'failed', failure: { kind: 'failed', words: e instanceof Error ? e.message : 'The change was not saved.' } };
      }
      this.onChange();
      return { kind: 'edited' };
    })) as Reply;
  }

  /** A change that doesn't touch what runs (enabled, limits, the tools seen and reviewed). */
  async update(change: (r: SavedServer) => SavedServer): Promise<Reply> {
    return (await this.change(async (): Promise<Reply> => {
      try {
        await this.save(change(this.record));
      } catch (e) {
        return { kind: 'failed', failure: { kind: 'failed', words: e instanceof Error ? e.message : 'The change was not saved.' } };
      }
      this.onChange();
      return { kind: 'edited' };
    })) as Reply;
  }

  /** Stops it (awaited), then removes what the exe and the store keep for it. */
  async remove(): Promise<Reply> {
    if (this.changing) return BUSY;
    if (this.phaseNow === 'ready' || this.phaseNow === 'starting') await this.stop();
    return (await this.change(async (): Promise<Reply> => {
      this.set('removing');
      const setup = this.record.setup;
      try {
        if (setup.kind === 'local') {
          await this.ports.processes.forget(setup.id);
          for (const ref of secretRefs(setup)) await this.ports.secrets.delete(ref);
        } else if (setup.address) {
          await this.ports.addresses.remove(setup.address);
        }
        await deleteServer(this.ports.store, setup.id, this.record.incarnation);
      } catch (e) {
        this.set('stopped', { kind: 'failed', words: `Removing it didn't finish: ${e instanceof Error ? e.message : 'try again'}.` });
        return { kind: 'failed', failure: this.failureNow! };
      }
      this.set('removed');
      return { kind: 'removed' };
    })) as Reply;
  }
}

function linkLimitsOf(record: SavedServer): Partial<LinkLimits> {
  const initMs = record.limits.initMs;
  return initMs === undefined ? {} : { startMs: Math.min(300_000, Math.max(5_000, initMs)) };
}
