// W, the exchange machine's exhaustive walk (docs/mcp-design.md 7.3). Every interleaving of the machine's
// inputs for one server, in each era and place, with up to 3 pings (so 2 pongs outstanding and a flood),
// and up to two exchanges per path. States are deduplicated exactly: a Set of the canonical state's JSON,
// compared by string equality, never by a hash. It checks H1's rule (no native request of one exchange
// open while another exchange's is; the request and two pongs at most, plus a local stop's cancel) and
// liveness: from every reachable state, once every native request and write has ended and every request
// kind has its answer or its deadline, the slot is Idle. A write-only exchange gets no answer and has no
// deadline, so one that waits for a response fails. Its controls are H1's mutations.

import { describe, expect, it } from 'vitest';
import { mutations } from '../../src/mutations.ts';
import { emptySlot, step, type End, type ExchangeKind, type Input, type Slot } from '../../src/mcp/wire/exchange.ts';

type Where = 'local' | 'remote';
type Era = 'legacy' | 'modern';

interface Handle {
  readonly h: string;
  readonly n: number;
  readonly what: 'request' | 'pong' | 'cancel';
  /** Remote: net_cancel asked. */
  readonly cancelAsked: boolean;
  /** Remote pong: its head arrived. */
  readonly head: boolean;
}

interface State {
  readonly slot: Slot;
  /** Native requests or writes not yet ended, in the order sent. */
  readonly open: readonly Handle[];
  readonly admits: number;
  readonly pings: number;
}

const ENDS: End[] = [{ t: 'timeout' }, { t: 'stopped' }, { t: 'stream-ended' }, { t: 'run-ended' }];
const MAX_ADMITS = 2;
const MAX_PINGS = 3;

function kinds(where: Where, era: Era): ExchangeKind[] {
  if (era === 'modern') return ['list', 'call'];
  return where === 'local' ? ['initialize', 'initialized', 'list', 'call', 'pong'] : ['initialize', 'initialized', 'list', 'call'];
}

const writeOnly = (k: ExchangeKind) => k === 'initialized' || k === 'pong';

/** Applies one input, doing the effects to the native world as the link would. */
function apply(s: State, input: Input | { t: 'restart' }, where: Where): { next: State; problems: string[] } {
  let slot = s.slot;
  let effects: readonly ReturnType<typeof step>['effects'][number][] = [];
  if (input.t === 'restart') {
    // Stop and Start of the same server, as the link does them: Stop ends the live exchange in its own step
    // (the slot is the server's, so a drain carries on).
    if (slot.ex && slot.ex.phase === 'live') {
      const r = step(slot, { t: 'terminal', n: slot.ex.n, end: { t: 'run-ended' } });
      slot = r.slot;
      effects = r.effects;
    }
  } else {
    const r = step(slot, input);
    slot = r.slot;
    effects = r.effects;
  }
  let open = [...s.open];
  const problems: string[] = [];
  for (const e of effects) {
    if (e.t === 'send') {
      const n = Number(e.handle.split(':')[0]);
      const others = open.filter((o) => o.n !== n);
      if (others.length) problems.push(`H1: ${e.handle} sent while ${others.map((o) => o.h).join(',')} of another exchange is open`);
      open.push({ h: e.handle, n, what: e.message, cancelAsked: false, head: false });
      const mine = open.filter((o) => o.n === n);
      if (mine.filter((o) => o.what !== 'cancel').length > 3 || mine.length > 4) problems.push(`H1: ${mine.length} open for exchange ${n}`);
    }
    if (e.t === 'cancel') open = open.map((o) => (o.h === e.handle ? { ...o, cancelAsked: true } : o));
  }
  if (input.t === 'released') open = open.filter((o) => o.h !== input.handle);
  if (input.t === 'pong-head') open = open.map((o) => (o.h === input.handle ? { ...o, head: true } : o));
  void where;
  return { next: { slot, open, admits: s.admits + (input.t === 'admit' && !effects.some((e) => e.t === 'busy') ? 1 : 0), pings: s.pings + (input.t === 'ping' ? 1 : 0) }, problems };
}


/** The inputs that can come next: the world's native events, the person's, the server's. */
function inputs(s: State, where: Where, era: Era): (Input | { t: 'restart' })[] {
  const out: (Input | { t: 'restart' })[] = [];
  const ex = s.slot.ex;
  if (s.admits < MAX_ADMITS) for (const kind of kinds(where, era)) out.push({ t: 'admit', kind, where, era, ...(writeOnly(kind) ? {} : { requestId: s.slot.next }) });
  if (ex) {
    const req = s.open.find((o) => o.n === ex.n && o.what === 'request');
    // An answer can come while the request is still natively open (remote: before net_cancel).
    if (req && !req.cancelAsked) out.push({ t: 'completed', n: ex.n });
    for (const end of ENDS) out.push({ t: 'terminal', n: ex.n, end });
    if (era === 'legacy' && s.pings < MAX_PINGS && (where === 'local' || (req && !req.cancelAsked))) out.push({ t: 'ping', n: ex.n, id: `p${s.pings + 1}` });
  }
  for (const o of s.open) {
    if (where === 'local') out.push({ t: 'released', handle: o.h });
    else if (o.cancelAsked) out.push({ t: 'released', handle: o.h });
    else if (o.what === 'pong' && !o.head) out.push({ t: 'pong-head', handle: o.h });
  }
  if (s.admits < MAX_ADMITS) out.push({ t: 'restart' });
  return out;
}

/** From `s`, only native endings, answers and deadlines (no admits, no pings): the slot must reach Idle. */
function settles(s: State, where: Where, seen: Map<string, boolean>): boolean {
  const key = JSON.stringify(s);
  const known = seen.get(key);
  if (known !== undefined) return known;
  seen.set(key, false); // a cycle doesn't settle
  if (!s.slot.ex && s.open.length === 0) return seen.set(key, true), true;
  const ex = s.slot.ex;
  const moves: Input[] = [];
  if (ex && ex.phase === 'live' && !(where === 'local' && writeOnly(ex.kind))) {
    // A request kind gets its answer or its deadline; a remote write-only one its 202 head or a native end.
    const req = s.open.find((o) => o.n === ex.n && o.what === 'request');
    if (req && !req.cancelAsked) moves.push({ t: 'completed', n: ex.n });
    moves.push({ t: 'terminal', n: ex.n, end: { t: 'timeout' } });
  }
  for (const o of s.open) {
    if (where === 'local' || o.cancelAsked) moves.push({ t: 'released', handle: o.h });
    else if (o.what === 'pong' && !o.head) moves.push({ t: 'pong-head', handle: o.h });
  }
  // Every way of finishing must settle: a single stuck branch fails.
  let ok = moves.length > 0;
  for (const m of moves) {
    const { next } = apply(s, m, where);
    if (JSON.stringify(next) === key) continue;
    if (!settles(next, where, seen)) {
      ok = false;
      break;
    }
  }
  seen.set(key, ok);
  return ok;
}

interface Walked {
  readonly states: number;
  readonly problems: string[];
  readonly restarts: number;
}

function walk(where: Where, era: Era): Walked {
  const start: State = { slot: emptySlot, open: [], admits: 0, pings: 0 };
  const seen = new Set<string>([JSON.stringify(start)]);
  const settled = new Map<string, boolean>();
  const todo: State[] = [start];
  const problems: string[] = [];
  let restarts = 0;
  while (todo.length && problems.length < 200) {
    const s = todo.pop()!;
    if (!settles(s, where, settled)) problems.push(`liveness: stuck from ${JSON.stringify(s).slice(0, 200)}`);
    for (const input of inputs(s, where, era)) {
      if (input.t === 'restart') restarts++;
      const { next, problems: p } = apply(s, input, where);
      for (const x of p) problems.push(`${x} after ${JSON.stringify(input)}`);
      const key = JSON.stringify(next);
      if (seen.has(key)) continue;
      seen.add(key);
      todo.push(next);
    }
  }
  return { states: seen.size, problems, restarts };
}

const PLACES: [Where, Era][] = [
  ['local', 'legacy'],
  ['remote', 'legacy'],
  ['local', 'modern'],
  ['remote', 'modern']
];

describe('W: the exchange machine, every interleaving', () => {
  for (const [where, era] of PLACES) {
    it(`${where} ${era}: H1 holds and every path settles`, () => {
      mutations.clear();
      const w = walk(where, era);
      expect(w.problems).toEqual([]);
      // Legacy has pings, so many more states; both must be more than a handful.
      expect(w.states).toBeGreaterThan(era === 'legacy' ? 1000 : 20);
      // A Stop and Start was reachable, and every state it led to settled.
      expect(w.restarts).toBeGreaterThan(0);
    });
  }

  const CONTROLS: [string, Where, Era, RegExp][] = [
    ['free-slot-at-response', 'remote', 'legacy', /^H1/],
    ['admit-while-draining', 'remote', 'legacy', /^H1/],
    ['page-before-drain', 'remote', 'modern', /^H1/],
    ['write-only-on-response', 'local', 'legacy', /^liveness/]
  ];
  // slot-per-run is the link's (a Start resets the slot), not the machine's: its control runs through
  // ServerLink in the wire harness (wire.mutations.test.ts, under S8), never as a reset W makes itself.
  for (const [mutation, where, era, fails] of CONTROLS) {
    it(`fails under ${mutation}`, () => {
      mutations.set([mutation]);
      try {
        const w = walk(where, era);
        expect(w.problems.find((p) => fails.test(p)), w.problems[0]).toBeDefined();
      } finally {
        mutations.clear();
      }
    });
  }
});
