// Caps on what model calls may spend, kept as a reservation ledger. A pure unit: the clock and the
// usage store are passed in. The app's store is the journal's (journal/ledger.ts), so open reservations
// and settled spend survive a restart.
//
//   - `before` reserves a call's worst case, in tokens and in dollars, against today's settled spend
//     plus every open reservation, all in one atomic update of the store. If that would pass a cap,
//     the call pauses and nothing is reserved or sent. So two calls that overlap, in one instance or
//     two on the same store, can't both spend the same remainder.
//   - The worst case is the input's upper bound (`inputBound`) plus the reply's cap, priced at the
//     highest rate that could apply. With caching on, input may be billed as a cache write, so the
//     input rate is the higher of the two. If any rate that could apply is unknown, a dollar cap pauses.
//   - `settle` reconciles a reservation with how the call ended. It drops to the actual usage only when
//     the endpoint reported its final usage for the call, and releases it only when the endpoint said
//     the request wasn't processed. Anything else (a stop, an error after sending, a stream that ended
//     early, usage that's missing or partial) keeps the reservation as spent, or the reported usage if
//     that's more. A reservation not settled within `reservationMs` stays spent. Only the instance that
//     made a reservation settles it, so one left open by a restart stays spent too.
//   - A cost it can't price is 'unknown', never $0, and is counted by its tokens.

import type { ModelEvent, ModelPort, ModelRequest, Usage } from './port.ts';

/** US dollars per million tokens. A cache price left out is unknown, not free. */
export interface Rates {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok?: number;
  readonly cacheWritePerMTok?: number;
}

/** Rates that apply instead of the base ones when a call's input is above `inputTokensAbove`. */
export interface PriceTier extends Rates {
  readonly inputTokensAbove: number;
}

export interface Price extends Rates {
  readonly tiers?: readonly PriceTier[];
  /** Where it came from: the endpoint's own list, Familiar's model catalog, the person, or a local server. */
  readonly source?: 'endpoint' | 'catalog' | 'typed' | 'local';
}

export type Cost = { readonly usd: number } | { readonly usd: 'unknown' };

function ratesFor(price: Price, inputTokens: number): Rates {
  let r: Rates = price;
  for (const t of [...(price.tiers ?? [])].sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)) if (inputTokens > t.inputTokensAbove) r = t;
  return r;
}

export function costOf(usage: Usage, price: Price | undefined): Cost {
  if (!price) return { usd: 'unknown' };
  const r = ratesFor(price, usage.inputTokens);
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  if ((read > 0 && r.cacheReadPerMTok === undefined) || (write > 0 && r.cacheWritePerMTok === undefined)) return { usd: 'unknown' };
  const plain = Math.max(0, usage.inputTokens - read - write);
  return { usd: (plain * r.inputPerMTok + read * (r.cacheReadPerMTok ?? 0) + write * (r.cacheWritePerMTok ?? 0) + usage.outputTokens * r.outputPerMTok) / 1e6 };
}

/**
 * The most a call could cost: every input token at the highest input rate that could apply, every
 * output token at the highest output rate. With caching, input may be billed as a cache read or a
 * cache write, so those rates must be known too. Unknown if any rate that could apply is.
 */
export function worstCost(inputTokens: number, outputTokens: number, price: Price | undefined, caching: boolean): Cost {
  if (!price) return { usd: 'unknown' };
  let input = 0, output = 0;
  for (const r of [price, ...(price.tiers ?? [])]) {
    if (caching && (r.cacheReadPerMTok === undefined || r.cacheWritePerMTok === undefined)) return { usd: 'unknown' };
    input = Math.max(input, r.inputPerMTok, caching ? r.cacheWritePerMTok! : 0, caching ? r.cacheReadPerMTok! : 0);
    output = Math.max(output, r.outputPerMTok);
  }
  return { usd: (inputTokens * input + outputTokens * output) / 1e6 };
}

/* ---------- the input bound ---------- */

/** Tokens a message's wrapping can add (role markers and separators), and a request's. Generous. */
export const MESSAGE_FRAME = 16;
export const REQUEST_FRAME = 64;

const utf8 = (s: string) => new TextEncoder().encode(s).length;

function messageBytes(m: ModelRequest['messages'][number]): number {
  return utf8(JSON.stringify(m));
}

/**
 * An upper bound on a request's input tokens: its UTF-8 bytes plus framing. Byte-level tokenizers
 * never give more than one token per byte, whatever the script (CJK and emoji take three or four bytes
 * a character). Everything sent counts, JSON quoting and replay state included, which only errs high.
 */
export function inputBound(request: ModelRequest): number {
  return utf8(request.system) + utf8(JSON.stringify(request.tools)) + request.messages.reduce((n, m) => n + messageBytes(m) + MESSAGE_FRAME, 0) + REQUEST_FRAME;
}

/* FNV-1a over a string, twice with different seeds: a fingerprint of a conversation's prefix. */
function fingerprint(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 ^ 0x2c1b3c6d) >>> 0;
  }
  return `${a.toString(16)}.${b.toString(16)}.${s.length}`;
}
const prefixOf = (r: ModelRequest, k: number) => fingerprint(JSON.stringify([r.system, r.tools, r.thinking ?? null, r.messages.slice(0, k)]));
/* A remembered input count holds only for the same endpoint and model: another tokenizer, or another
   way of putting the request together, counts the same history differently. */
const seenKey = (c: CallInfo) => JSON.stringify([c.conversation, c.endpoint ?? '', c.request.model]);

/** A usage the endpoint reported as whole, non-negative numbers. Anything else isn't a count. */
export function wholeUsage(u: Usage | undefined): u is Usage {
  const ok = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  return !!u && typeof u === 'object' && ok(u.inputTokens) && ok(u.outputTokens)
    && (u.cacheReadTokens === undefined || ok(u.cacheReadTokens)) && (u.cacheWriteTokens === undefined || ok(u.cacheWriteTokens));
}

/** The last final input count seen for a conversation, and the prefix it was for. */
interface Seen {
  readonly k: number;
  readonly prefix: string;
  readonly inputTokens: number;
}

/* ---------- the ledger ---------- */

export interface UsageRecord {
  readonly at: number;
  /** The local day it counts toward, YYYY-MM-DD. */
  readonly day: string;
  readonly persona: string;
  readonly turn: string;
  readonly model: string;
  readonly tokens: number;
  readonly cost: Cost;
  /** The reservation it settled. */
  readonly reservation: string;
}

export interface Reservation {
  readonly id: string;
  readonly at: number;
  readonly day: string;
  readonly persona: string;
  readonly turn: string;
  readonly model: string;
  readonly tokens: number;
  readonly usd: number | 'unknown';
  /** After this, unsettled, it stays spent. */
  readonly deadline: number;
}

/**
 * The ledger as one value: settled records, open reservations, and, for turns settled more than
 * `FOLD_AFTER_MS` ago, their tokens per turn, so a turn keeps its cap however old it is without the
 * ledger growing a record per call forever.
 */
export interface Ledger {
  records: UsageRecord[];
  open: Reservation[];
  /** Settled tokens per turn, and when it was last used, of records folded out of `records`. */
  turns: Record<string, { tokens: number; last: number }>;
  /**
   * Extra allowances the person gave a turn, one per Yes at a turn-tokens pause: a turn may use
   * `maxTurnTokens * (1 + extensions[turn])`. The only way a turn's allowance grows. Daily and dollar caps
   * have none.
   */
  extensions: Record<string, number>;
  /** Which Yes granted an extension, and for which turn: one Yes grants at most one. */
  granted: Record<string, string>;
  /**
   * Turns the store says can still resume, read in the same commit as the change (the journal's turn
   * registry). Not stored: `tidy` keeps them whole, never folded or dropped, however old.
   */
  resumable?: readonly string[];
}

/**
 * Where the ledger lives. `update` runs `change` on the whole ledger as one atomic step: no other
 * update, in this instance or any other that opens the same store, sees the ledger between its read and
 * its write. `change` is synchronous and may mutate the ledger it gets; what it returns is returned.
 * Atomicity is the store's, not a lock in the caller: the journal's store runs it as one commit of the
 * journal's single owner (journal/ledger.ts), the memory store runs it without yielding.
 */
export interface UsageStore {
  update<T>(change: (ledger: Ledger) => T): Promise<T>;
  /** A copy of the ledger as it is now. */
  read(): Promise<Ledger>;
}

export interface Clock {
  now(): number;
}

export interface CapsConfig {
  /** The most output tokens any one reply may have. */
  readonly maxReplyTokens: number;
  readonly maxTurnTokens?: number;
  readonly maxDayTokens?: number;
  /** Optional daily spending caps in US dollars, by persona id. */
  readonly personaDayUsd?: Readonly<Record<string, number>>;
}

export type PauseReason = 'turn-tokens' | 'day-tokens' | 'persona-day-usd' | 'persona-unpriced';

export type CapCheck =
  | {
      readonly go: true;
      readonly maxOutputTokens: number;
      readonly reservation: string;
      readonly inputBound: number;
      readonly reserved: { readonly tokens: number; readonly usd: number | 'unknown' };
    }
  | { readonly go: false; readonly pause: PauseReason; readonly message: string };

export interface CallInfo {
  readonly request: ModelRequest;
  readonly persona: string;
  readonly turn: string;
  /** The conversation, so a later call can reuse this one's input count for their shared prefix. */
  readonly conversation?: string;
  /** The endpoint (its address, or its preset and API): a remembered input count is kept per endpoint and model. */
  readonly endpoint?: string;
  readonly price: Price | undefined;
  /** Whether the endpoint may bill input as cache reads or writes. */
  readonly caching?: boolean;
}

type Terminal = Extract<ModelEvent, { type: 'done' | 'error' }>;

export interface Caps {
  before(call: CallInfo): Promise<CapCheck>;
  /**
   * Reconciles a reservation with the call's last event, or with nothing if the stream stopped before
   * one. Returns what was recorded, or undefined for a reservation already settled or expired.
   */
  settle(reservation: string, last: Terminal | undefined): Promise<Cost | undefined>;
}

/** The local calendar day of a moment, YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const usdText = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const tokensOf = (u: Usage | undefined) => (wholeUsage(u) ? u.inputTokens + u.outputTokens : 0);

export interface CapsOptions {
  readonly dayOf?: (ms: number) => string;
  /** How long a reservation may stay open before it counts as spent. Default 30 minutes. */
  readonly reservationMs?: number;
  readonly newId?: () => string;
  /** Turns that aren't finished and can still go on: their spend is never folded away or dropped. */
  readonly unfinished?: () => Iterable<string>;
}

/** Records settled longer ago than this fold into per-turn totals. Two days, so today and yesterday stay whole. */
export const FOLD_AFTER_MS = 2 * 24 * 60 * 60_000;
/** A folded turn last used longer ago than this is dropped: no turn runs for a month. */
export const DROP_TURN_AFTER_MS = 30 * 24 * 60 * 60_000;

/**
 * Grants a turn one more allowance of `maxTurnTokens`: the person's Yes at a turn-tokens pause. `yes`
 * names that Yes, so the same Yes given twice grants once. Returns whether it granted.
 */
export function extendTurn(ledger: Ledger, turn: string, yes: string): boolean {
  if (ledger.granted[yes] !== undefined) return false;
  ledger.granted[yes] = turn;
  ledger.extensions[turn] = (ledger.extensions[turn] ?? 0) + 1;
  return true;
}

export function emptyLedger(): Ledger {
  return { records: [], open: [], turns: {}, extensions: {}, granted: {} };
}

export function createCaps(config: CapsConfig, store: UsageStore, clock: Clock, opts: CapsOptions = {}): Caps {
  const dayOf = opts.dayOf ?? localDay;
  const ttl = opts.reservationMs ?? 30 * 60_000;
  let n = 0;
  const newId = opts.newId ?? (() => `r${clock.now().toString(36)}-${(n++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  // What this instance needs to settle its own calls. A reservation made by another instance, or by this
  // one before a restart, has no entry here, so nothing settles it: it stays spent, and becomes a record
  // at its deadline.
  const pending = new Map<string, CallInfo>();
  const seen = new Map<string, Seen>();

  /** Open past their deadline: spent as reserved. Old records fold into per-turn totals. */
  /**
   * Open past their deadline: spent as reserved. Old records of finished turns fold into per-turn totals,
   * and a folded turn unused for a month is dropped. A turn that isn't finished, the one asking now or
   * any `unfinished` says, keeps its records whole and is never dropped, however old: a turn can wait
   * weeks on a consent card and then go on.
   */
  function tidy(ledger: Ledger, now: number, asking?: string): void {
    for (const r of ledger.open.filter((x) => x.deadline <= now)) {
      ledger.open.splice(ledger.open.indexOf(r), 1);
      ledger.records.push({ at: r.at, day: r.day, persona: r.persona, turn: r.turn, model: r.model, tokens: r.tokens, cost: { usd: r.usd } as Cost, reservation: r.id });
      pending.delete(r.id);
    }
    const live = new Set([...(opts.unfinished?.() ?? []), ...(ledger.resumable ?? [])]);
    if (asking !== undefined) live.add(asking);
    for (const p of pending.values()) live.add(p.turn);
    const folds = (r: UsageRecord) => r.at < now - FOLD_AFTER_MS && !live.has(r.turn);
    if (ledger.records.some(folds)) {
      for (const r of ledger.records.filter(folds)) {
        const t = ledger.turns[r.turn];
        ledger.turns[r.turn] = { tokens: (t?.tokens ?? 0) + r.tokens, last: Math.max(t?.last ?? 0, r.at) };
      }
      ledger.records = ledger.records.filter((r) => !folds(r));
    }
    for (const [turn, t] of Object.entries(ledger.turns)) {
      if (t.last >= now - DROP_TURN_AFTER_MS || live.has(turn)) continue;
      delete ledger.turns[turn];
      delete ledger.extensions[turn];
      for (const [yes, t] of Object.entries(ledger.granted)) if (t === turn) delete ledger.granted[yes];
    }
  }

  function boundFor(call: CallInfo): number {
    const full = inputBound(call.request);
    const s = call.conversation ? seen.get(seenKey(call)) : undefined;
    const msgs = call.request.messages;
    if (!s || msgs.length < s.k || prefixOf(call.request, s.k) !== s.prefix) return full;
    const added = msgs.slice(s.k).reduce((t, m) => t + messageBytes(m) + MESSAGE_FRAME, 0);
    return Math.min(full, s.inputTokens + added);
  }

  return {
    async before(call) {
      // What doesn't read the ledger is worked out first. The check and the reservation are one update.
      const maxOutputTokens = Math.max(1, Math.min(call.request.maxOutputTokens ?? config.maxReplyTokens, config.maxReplyTokens));
      const input = boundFor(call);
      const tokens = input + maxOutputTokens;
      const worst = worstCost(input, maxOutputTokens, call.price, call.caching ?? false);
      const id = newId();
      const result = await store.update((ledger): CapCheck => {
        const now = clock.now();
        tidy(ledger, now, call.turn);
        const day = dayOf(now);
        // A turn is counted across every date, so one that runs past midnight keeps its cap; the
        // daily limits count only today.
        const records = ledger.records.filter((r) => r.day === day);
        const open = ledger.open.filter((r) => r.day === day);
        const sum = (xs: readonly { tokens: number }[]) => xs.reduce((t, x) => t + x.tokens, 0);

        if (config.maxTurnTokens !== undefined) {
          const mine = (r: { turn: string }) => r.turn === call.turn;
          const used = (ledger.turns[call.turn]?.tokens ?? 0) + sum(ledger.records.filter(mine)) + sum(ledger.open.filter(mine));
          const allowance = config.maxTurnTokens * (1 + (ledger.extensions[call.turn] ?? 0));
          if (used + tokens > allowance) {
            return {
              go: false,
              pause: 'turn-tokens',
              message: `This turn has used or set aside ${used} tokens. One more reply could take it past its allowance of ${allowance}. Say yes to give it ${config.maxTurnTokens} more.`
            };
          }
        }
        if (config.maxDayTokens !== undefined) {
          const used = sum(records) + sum(open);
          if (used + tokens > config.maxDayTokens) {
            return { go: false, pause: 'day-tokens', message: `Today has used or set aside ${used} tokens. One more reply could take it past the daily cap of ${config.maxDayTokens}. Raise the daily cap, or wait until tomorrow.` };
          }
        }
        const cap = config.personaDayUsd?.[call.persona];
        if (cap !== undefined) {
          const mine = [...records.filter((r) => r.persona === call.persona).map((r) => r.cost.usd), ...open.filter((r) => r.persona === call.persona).map((r) => r.usd)];
          if (worst.usd === 'unknown' || mine.includes('unknown')) {
            return {
              go: false,
              pause: 'persona-unpriced',
              message: `This persona has a daily cap of ${usdText(cap)}, but ${worst.usd === 'unknown' ? "this model's price isn't fully known" : "some of today's use had no known price"}, so the cap can't be kept. Add the model's price, or use a token cap instead.`
            };
          }
          const spent = (mine as number[]).reduce((t, x) => t + x, 0);
          if (spent + worst.usd > cap) {
            return {
              go: false,
              pause: 'persona-day-usd',
              message: `This persona has spent or set aside ${usdText(spent)} today. One more reply could cost up to ${usdText(worst.usd)}, past its daily cap of ${usdText(cap)}. Raise the cap, or wait until tomorrow.`
            };
          }
        }
        ledger.open.push({ id, at: now, day, persona: call.persona, turn: call.turn, model: call.request.model, tokens, usd: worst.usd, deadline: now + ttl });
        return { go: true, maxOutputTokens, reservation: id, inputBound: input, reserved: { tokens, usd: worst.usd } };
      });
      if (result.go) pending.set(id, call);
      return result;
    },

    async settle(id, last) {
      const call = pending.get(id);
      if (!call) return undefined;
      pending.delete(id);
      // Final only when the endpoint said so and the counts are whole numbers: an empty or partial
      // usage object is no count at all.
      const said = last?.type === 'done' ? !last.unreported : last?.type === 'error' && last.usageFinal === true;
      const final = said && wholeUsage(last?.usage) ? last!.usage : undefined;
      const cost = await store.update((ledger): Cost | undefined => {
        tidy(ledger, clock.now(), call.turn);
        const i = ledger.open.findIndex((r) => r.id === id);
        if (i < 0) return undefined;
        const r = ledger.open.splice(i, 1)[0]!;
        // The endpoint said it didn't take the request: nothing was billed.
        if (last?.type === 'error' && last.error.notProcessed) return { usd: 0 };
        let tokens: number, cost: Cost;
        if (final) {
          tokens = tokensOf(final);
          cost = costOf(final, call.price);
        } else {
          // Not the endpoint's final word: it stays spent as reserved, or as reported if that's more.
          const partial = wholeUsage(last?.usage) ? last.usage : undefined;
          const reportedCost = partial ? costOf(partial, call.price) : undefined;
          tokens = Math.max(r.tokens, tokensOf(partial));
          cost = r.usd === 'unknown' || reportedCost?.usd === 'unknown' ? { usd: 'unknown' } : { usd: Math.max(r.usd, reportedCost?.usd ?? 0) };
        }
        ledger.records.push({ at: r.at, day: r.day, persona: r.persona, turn: r.turn, model: r.model, tokens, cost, reservation: r.id });
        return cost;
      });
      if (cost && final && call.conversation) {
        seen.set(seenKey(call), { k: call.request.messages.length, prefix: prefixOf(call.request, call.request.messages.length), inputTokens: final.inputTokens });
      }
      return cost;
    }
  };
}

/**
 * A model port under caps: each call reserves before it's sent, and settles with however it ended,
 * even when the reader stops early. Over a cap, the call ends at once in a `paused` error. Put retries
 * outside it, so each try takes its own reservation.
 */
export function cappedPort(port: ModelPort, caps: Caps, info: (request: ModelRequest) => Omit<CallInfo, 'request'>): ModelPort {
  return {
    async *stream(request, signal) {
      const c = await caps.before({ ...info(request), request });
      if (!c.go) {
        yield { type: 'error', error: { kind: 'paused', message: c.message, pause: c.pause } };
        return;
      }
      let last: Terminal | undefined;
      try {
        for await (const e of port.stream({ ...request, maxOutputTokens: c.maxOutputTokens }, signal)) {
          if (e.type === 'done' || e.type === 'error') last = e;
          yield e;
        }
      } finally {
        await caps.settle(c.reservation, last);
      }
    }
  };
}

/**
 * A usage store in memory, for tests. `pause` runs before every update and read, so a test can interleave
 * calls; the change itself runs without yielding, so an update is atomic.
 */
export function memoryUsageStore(pause: () => Promise<void> = async () => {}): UsageStore & { readonly all: readonly UsageRecord[]; readonly reservations: readonly Reservation[]; readonly extensions: Readonly<Record<string, number>>; readonly folded: Ledger['turns'] } {
  let ledger = emptyLedger();
  const copy = (l: Ledger): Ledger => structuredClone(l);
  return {
    get all() { return ledger.records; },
    get reservations() { return ledger.open; },
    get extensions() { return ledger.extensions; },
    get folded() { return ledger.turns; },
    async update(change) {
      await pause();
      // On a throw nothing changes, as a store transaction would roll back.
      const next = copy(ledger);
      const out = change(next);
      ledger = next;
      return out;
    },
    async read() {
      await pause();
      return copy(ledger);
    }
  };
}
