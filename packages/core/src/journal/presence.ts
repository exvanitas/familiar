// The state the turn loop reports, in the shape of a presence snapshot. In part 1 it's the chat's status
// line; part 2 points the same port at the buddy driver.
//
// A snapshot is the whole current state, not a log. Within one `gen` the newest `seq` wins; each start of
// the journal takes a new `gen`, so a restarted loop's low numbers aren't ignored. A state ends on its own
// after `ttl` seconds unless it's sent again.

export type PresenceState = 'idle' | 'thinking' | 'working' | 'waiting' | 'speaking' | 'error';

export interface PresenceSnapshot {
  readonly v: 1;
  readonly agent: string;
  readonly gen: string;
  readonly seq: number;
  readonly state: PresenceState;
  /** While working: the tool's name. */
  readonly tool?: string;
  /** Seconds this holds unless sent again. At most 60. */
  readonly ttl: number;
}

export interface PresencePort {
  report(snapshot: PresenceSnapshot): void;
}

export const PRESENCE_TTL = 60;

/** What the state is read from: pi-durable's live document, and Familiar's own waits. */
export interface StateInputs {
  readonly live: any;
  /** A consent card is open, a cap paused the turn, or the step cap asks to go on. */
  readonly waiting: boolean;
  /** The last run ended with an error that isn't a pause or a question. */
  readonly failed: boolean;
}

/** Waiting beats working beats thinking. Speaking is a reply streaming in. */
export function stateOf({ live, waiting, failed }: StateInputs): { state: PresenceState; tool?: string } {
  if (waiting) return { state: 'waiting' };
  const run = live?.run;
  if (!run) return { state: failed ? 'error' : 'idle' };
  const busy = (live.tools ?? []).find((t: any) => t.status !== 'done');
  if (busy) return { state: 'working', tool: busy.name };
  const content = live.generation?.message?.content;
  if (Array.isArray(content) && content.some((b: any) => b?.type === 'text' && b.text)) return { state: 'speaking' };
  return { state: 'thinking' };
}

/** Sends a snapshot whenever the state or tool changes, numbering them within one generation. */
export function presenceReporter(port: PresencePort, agent: string, gen: string) {
  let seq = 0;
  let last = '';
  let stopped = false;
  return {
    update(next: { state: PresenceState; tool?: string }) {
      if (stopped) return;
      const key = `${next.state}:${next.tool ?? ''}`;
      if (key === last) return;
      last = key;
      port.report({ v: 1, agent, gen, seq: ++seq, state: next.state, ...(next.tool ? { tool: next.tool } : {}), ttl: PRESENCE_TTL });
    },
    stop() {
      stopped = true;
    }
  };
}
