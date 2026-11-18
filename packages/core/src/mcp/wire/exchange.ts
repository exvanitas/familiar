// One exchange at a time per server, behind a cleanup barrier (docs/mcp-design.md 3.4). A pure function:
// the state and one input give the next state and the effects to do. The driver (client.ts) does the
// effects and feeds back what the natives answer. W, the exhaustive walk, explores this function.
//
// An exchange is one request Familiar sends, plus every pong it sends for pings that arrived on it, plus,
// for a local call ended by Stop or its time limit, its cancel write. It owns every native request it
// makes: remote, the request's POST and one POST per pong; local, one write each.
//
//   Idle      no exchange.                          Leaves on an admission (busy otherwise, no queue).
//   Live      handed off, waiting to complete.      Leaves on completion or any terminal path.
//   Draining  ended: no more sends of any kind.     Leaves when every native request it owns has ended.
//
// The first terminal event makes its own last sends (the local cancel), then seals, in one step. A
// remote request's POST is cancelled then; a pong already handed off is left to reach its head, within
// its own bounds, and is cancelled at its head, so a pong sent just before the final reply still arrives.

import { mutant } from '../../mutations.ts';
import type { Era, RpcId, Where } from './framing.ts';

export type ExchangeKind = 'initialize' | 'initialized' | 'list' | 'call' | 'pong';

/** At most this many pongs whose native request (remote) or write (local) hasn't ended, and in all, per exchange. */
export const MAX_PONGS_OUT = 2;
export const MAX_PONGS = 32;

export type End =
  | { readonly t: 'done' }
  /** The call's time limit, or the list's or handshake's deadline. */
  | { readonly t: 'timeout' }
  | { readonly t: 'stopped' }
  | { readonly t: 'stream-ended' }
  | { readonly t: 'flood' }
  | { readonly t: 'invalid'; readonly why: string }
  | { readonly t: 'native'; readonly kind: string }
  | { readonly t: 'redirected'; readonly status?: number }
  | { readonly t: 'line-too-long' }
  | { readonly t: 'session-ended' }
  | { readonly t: 'http'; readonly status: number }
  | { readonly t: 'run-ended' };

export interface Exchange {
  readonly n: number;
  readonly kind: ExchangeKind;
  readonly where: Where;
  readonly era: Era;
  readonly requestId?: number;
  readonly phase: 'live' | 'draining';
  /** Native requests or writes it owns that haven't ended. */
  readonly open: readonly string[];
  /** Remote handles whose net_cancel has been asked. */
  readonly cancelled: readonly string[];
  /** Pong handles whose native request (remote) or write (local) hasn't ended yet. */
  readonly pongsOut: readonly string[];
  readonly pongsTotal: number;
  /** Ping ids this exchange answered. */
  readonly answered: readonly RpcId[];
  readonly end?: End;
}

export interface Slot {
  /** The next exchange's number. Kept across a Stop and a Start: the slot is the server's, not a run's. */
  readonly next: number;
  readonly ex?: Exchange;
}

export const emptySlot: Slot = { next: 1 };

export type Input =
  | { readonly t: 'admit'; readonly kind: ExchangeKind; readonly where: Where; readonly era: Era; readonly requestId?: number }
  /** The exchange completed: its response (request kinds), its 202 head (a remote notification). */
  | { readonly t: 'completed'; readonly n: number }
  /** A legacy ping on the live exchange's own stream. */
  | { readonly t: 'ping'; readonly n: number; readonly id: RpcId }
  /** A remote pong's head arrived. */
  | { readonly t: 'pong-head'; readonly handle: string }
  | { readonly t: 'terminal'; readonly n: number; readonly end: End }
  /** A native request or write ended: net_cancel returned, or the write completed or failed. */
  | { readonly t: 'released'; readonly handle: string };

export type Effect =
  /** Hand off the exchange's request (`message: 'request'`), a pong, or the local cancel. */
  | { readonly t: 'send'; readonly handle: string; readonly message: 'request' | 'pong' | 'cancel'; readonly pingId?: RpcId; readonly requestId?: number }
  | { readonly t: 'cancel'; readonly handle: string }
  /** Refused at once: another exchange holds the slot. */
  | { readonly t: 'busy' }
  /** The exchange ended: answer its caller. */
  | { readonly t: 'ended'; readonly n: number; readonly kind: ExchangeKind; readonly end: End }
  /** The slot is Idle again. */
  | { readonly t: 'idle'; readonly n: number }
  /** A ping that got no pong, and which named departure it is (H13). */
  | { readonly t: 'departure'; readonly n: number; readonly id: RpcId; readonly departure: 1 | 2 };

export interface Step {
  readonly slot: Slot;
  readonly effects: readonly Effect[];
}

const without = <T>(xs: readonly T[], x: T) => xs.filter((y) => y !== x);

/** Write-only kinds complete when their write does (local) or at their 202 head (remote). */
export const writeOnly = (kind: ExchangeKind) => kind === 'initialized' || kind === 'pong';

function settle(slot: Slot, ex: Exchange, effects: Effect[]): Step {
  if (ex.phase === 'draining' && ex.open.length === 0) return { slot: { next: slot.next }, effects: [...effects, { t: 'idle', n: ex.n }] };
  return { slot: { ...slot, ex }, effects };
}

/** The first terminal event: the last sends, then the seal, in one step. */
function terminate(slot: Slot, ex: Exchange, end: End, effects: Effect[]): Step {
  let open = ex.open;
  const out: Effect[] = [...effects];
  // A local call ended by Stop or its time limit: notifications/cancelled is the last send.
  if (ex.where === 'local' && ex.kind === 'call' && (end.t === 'stopped' || end.t === 'timeout') && ex.requestId !== undefined && !(__FAMILIAR_MUTATIONS__ && mutant('local-cancel-after-seal'))) {
    const handle = `${ex.n}:cancel`;
    out.push({ t: 'send', handle, message: 'cancel', requestId: ex.requestId });
    open = [...open, handle];
  }
  let cancelled = ex.cancelled;
  if (ex.where === 'remote') {
    // The request's POST is cancelled now; pongs still before their head are cancelled at their head.
    const req = `${ex.n}:req`;
    if (open.includes(req) && !cancelled.includes(req)) {
      out.push({ t: 'cancel', handle: req });
      cancelled = [...cancelled, req];
    }
    if (ex.pongsOut.length && (__FAMILIAR_MUTATIONS__ && mutant('cancel-pongs-at-drain'))) {
      for (const h of ex.pongsOut) if (!cancelled.includes(h)) out.push({ t: 'cancel', handle: h });
      cancelled = [...cancelled, ...ex.pongsOut];
    }
  }
  out.push({ t: 'ended', n: ex.n, kind: ex.kind, end });
  if (open.length && (__FAMILIAR_MUTATIONS__ && mutant('free-slot-at-response'))) return { slot: { next: slot.next }, effects: [...out, { t: 'idle', n: ex.n }] };
  return settle(slot, { ...ex, phase: 'draining', open, cancelled, end }, out);
}

export function step(slot: Slot, input: Input): Step {
  const ex = slot.ex;
  switch (input.t) {
    case 'admit': {
      if (ex && !(ex.phase === 'draining' && ((__FAMILIAR_MUTATIONS__ && mutant('admit-while-draining')) || (input.kind === 'list' && ex.kind === 'list' && (__FAMILIAR_MUTATIONS__ && mutant('page-before-drain')))))) return { slot, effects: [{ t: 'busy' }] };
      const n = slot.next;
      const handle = `${n}:req`;
      const fresh: Exchange = { n, kind: input.kind, where: input.where, era: input.era, ...(input.requestId !== undefined ? { requestId: input.requestId } : {}), phase: 'live', open: [handle], cancelled: [], pongsOut: [], pongsTotal: 0, answered: [] };
      return { slot: { next: n + 1, ex: fresh }, effects: [{ t: 'send', handle, message: 'request', ...(input.requestId !== undefined ? { requestId: input.requestId } : {}) }] };
    }
    case 'completed': {
      if (!ex || ex.n !== input.n || ex.phase !== 'live') return { slot, effects: [] };
      return terminate(slot, ex, { t: 'done' }, []);
    }
    case 'terminal': {
      if (!ex || ex.n !== input.n || ex.phase !== 'live') return { slot, effects: [] };
      return terminate(slot, ex, input.end, []);
    }
    case 'ping': {
      if (!ex || ex.n !== input.n || ex.era !== 'legacy') return { slot, effects: [] };
      if (ex.answered.includes(input.id)) return { slot, effects: [] };
      // Sealed: no send of any kind. Locally that's departure 2; a remote stream is parsed no further.
      if (ex.phase !== 'live' && !(__FAMILIAR_MUTATIONS__ && mutant('pong-after-end'))) return { slot, effects: ex.where === 'local' ? [{ t: 'departure', n: ex.n, id: input.id, departure: 2 }] : [] };
      if (ex.pongsOut.length >= MAX_PONGS_OUT || ex.pongsTotal >= MAX_PONGS) {
        return terminate(slot, ex, { t: 'flood' }, [{ t: 'departure', n: ex.n, id: input.id, departure: 1 }]);
      }
      const handle = `${ex.n}:pong:${ex.pongsTotal + 1}`;
      const next: Exchange = { ...ex, open: [...ex.open, handle], pongsOut: [...ex.pongsOut, handle], pongsTotal: ex.pongsTotal + 1, answered: [...ex.answered, input.id] };
      return { slot: { ...slot, ex: next }, effects: [{ t: 'send', handle, message: 'pong', pingId: input.id }] };
    }
    case 'pong-head': {
      if (!ex || !ex.open.includes(input.handle) || ex.cancelled.includes(input.handle)) return { slot, effects: [] };
      // A pong's body is never read: it's cancelled at its head. It stays outstanding until its native
      // request has ended, so the request and two pongs are all an exchange ever has open.
      return { slot: { ...slot, ex: { ...ex, cancelled: [...ex.cancelled, input.handle] } }, effects: [{ t: 'cancel', handle: input.handle }] };
    }
    case 'released': {
      if (!ex || !ex.open.includes(input.handle)) return { slot, effects: [] };
      let released: Exchange = { ...ex, open: without(ex.open, input.handle), pongsOut: without(ex.pongsOut, input.handle) };
      // The mutant's late cancel: sent after the seal, when the request's write ends.
      if (released.phase === 'draining' && released.where === 'local' && released.kind === 'call' && (released.end?.t === 'stopped' || released.end?.t === 'timeout') && !released.open.includes(`${ex.n}:cancel`) && input.handle === `${ex.n}:req` && released.requestId !== undefined && (__FAMILIAR_MUTATIONS__ && mutant('local-cancel-after-seal'))) {
        released = { ...released, open: [...released.open, `${ex.n}:cancel`] };
        return { slot: { ...slot, ex: released }, effects: [{ t: 'send', handle: `${ex.n}:cancel`, message: 'cancel', requestId: released.requestId }] };
      }
      // A local write-only exchange completes when its own write does.
      if (released.phase === 'live' && released.where === 'local' && writeOnly(released.kind) && input.handle === `${ex.n}:req` && !(__FAMILIAR_MUTATIONS__ && mutant('write-only-on-response'))) return terminate(slot, released, { t: 'done' }, []);
      return settle(slot, released, []);
    }
  }
}

/** Whether the slot holds an exchange (Live or Draining): a new one is refused busy. */
export const busy = (slot: Slot) => slot.ex !== undefined;
