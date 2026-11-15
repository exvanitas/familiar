// Caps on what model calls may spend, kept as a reservation ledger. A pure unit: the clock and the
// usage store are passed in (the real store arrives with the journal in step 5).
//
//   - `before` reserves a call's worst case, in tokens and in dollars, against today's settled spend
//     plus every open reservation, all in one step under one lock. If that would pass a cap, the call
//     pauses and nothing is reserved or sent. So two calls that overlap can't both spend the same
//     remainder.
//   - The worst case is the input's upper bound (`inputBound`) plus the reply's cap, priced at the
//     highest rate that could apply. With caching on, input may be billed as a cache write, so the
//     input rate is the higher of the two. If any rate that could apply is unknown, a dollar cap pauses.
//   - `settle` reconciles a reservation with how the call ended. It drops to the actual usage only when
//     the endpoint reported its final usage for the call, and releases it only when the endpoint said
//     the request wasn't processed. Anything else (a stop, an error after sending, a stream that ended
//     early, usage that's missing or partial) keeps the reservation as spent, or the reported usage if
//     that's more. A reservation not settled within `reservationMs` stays spent.
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

export interface UsageStore {
  add(record: UsageRecord): Promise<void>;
  /** Every settled record of one day, or of every day. */
  records(day?: string): Promise<readonly UsageRecord[]>;
  reserve(r: Reservation): Promise<void>;
  release(id: string): Promise<void>;
  /** Every open reservation. */
  open(): Promise<readonly Reservation[]>;
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
}

export function createCaps(config: CapsConfig, store: UsageStore, clock: Clock, opts: CapsOptions = {}): Caps {
  const dayOf = opts.dayOf ?? localDay;
  const ttl = opts.reservationMs ?? 30 * 60_000;
  let n = 0;
  const newId = opts.newId ?? (() => `r${clock.now().toString(36)}-${(n++).toString(36)}`);
  const pending = new Map<string, { call: CallInfo; reserved: Reservation }>();
  const seen = new Map<string, Seen>();

  // One lock over every read-then-write of the ledger, so no two calls see the same remainder.
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f);
    chain = run.catch(() => {});
    return run;
  };

  async function expire(now: number): Promise<void> {
    for (const r of await store.open()) {
      if (r.deadline > now) continue;
      await store.release(r.id);
      await store.add({ at: r.at, day: r.day, persona: r.persona, turn: r.turn, model: r.model, tokens: r.tokens, cost: { usd: r.usd } as Cost, reservation: r.id });
      pending.delete(r.id);
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
    before(call) {
      return locked(async () => {
        const now = clock.now();
        await expire(now);
        const day = dayOf(now);
        const maxOutputTokens = Math.max(1, Math.min(call.request.maxOutputTokens ?? config.maxReplyTokens, config.maxReplyTokens));
        const input = boundFor(call);
        const tokens = input + maxOutputTokens;
        const worst = worstCost(input, maxOutputTokens, call.price, call.caching ?? false);
        // A turn is counted across every date, so one that runs past midnight keeps its cap; the
        // daily limits count only today.
        const everything = await store.records();
        const records = everything.filter((r) => r.day === day);
        const allOpen = await store.open();
        const open = allOpen.filter((r) => r.day === day);
        const sum = (xs: readonly { tokens: number }[]) => xs.reduce((t, x) => t + x.tokens, 0);

        if (config.maxTurnTokens !== undefined) {
          const used = sum(everything.filter((r) => r.turn === call.turn)) + sum(allOpen.filter((r) => r.turn === call.turn));
          if (used + tokens > config.maxTurnTokens) {
            return { go: false, pause: 'turn-tokens', message: `This turn has used or set aside ${used} tokens. One more reply could take it past its cap of ${config.maxTurnTokens}.` };
          }
        }
        if (config.maxDayTokens !== undefined) {
          const used = sum(records) + sum(open);
          if (used + tokens > config.maxDayTokens) {
            return { go: false, pause: 'day-tokens', message: `Today has used or set aside ${used} tokens. One more reply could take it past the daily cap of ${config.maxDayTokens}.` };
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
              message: `This persona has spent or set aside ${usdText(spent)} today. One more reply could cost up to ${usdText(worst.usd)}, past its daily cap of ${usdText(cap)}.`
            };
          }
        }
        const reserved: Reservation = {
          id: newId(), at: now, day, persona: call.persona, turn: call.turn, model: call.request.model, tokens, usd: worst.usd, deadline: now + ttl
        };
        await store.reserve(reserved);
        pending.set(reserved.id, { call, reserved });
        return { go: true, maxOutputTokens, reservation: reserved.id, inputBound: input, reserved: { tokens, usd: worst.usd } };
      });
    },

    settle(id, last) {
      return locked(async () => {
        await expire(clock.now());
        const p = pending.get(id);
        if (!p || !(await store.open()).some((r) => r.id === id)) return undefined;
        pending.delete(id);
        const { call, reserved: r } = p;
        await store.release(id);
        // The endpoint said it didn't take the request: nothing was billed.
        if (last?.type === 'error' && last.error.notProcessed) return { usd: 0 };
        // Final only when the endpoint said so and the counts are whole numbers: an empty or partial
        // usage object is no count at all.
        const said = last?.type === 'done' ? !last.unreported : last?.type === 'error' && last.usageFinal === true;
        const final = said && wholeUsage(last?.usage) ? last!.usage : undefined;
        let tokens: number, cost: Cost;
        if (final) {
          tokens = tokensOf(final);
          cost = costOf(final, call.price);
          if (call.conversation) seen.set(seenKey(call), { k: call.request.messages.length, prefix: prefixOf(call.request, call.request.messages.length), inputTokens: final.inputTokens });
        } else {
          // Not the endpoint's final word: it stays spent as reserved, or as reported if that's more.
          const partial = wholeUsage(last?.usage) ? last.usage : undefined;
          const reportedCost = partial ? costOf(partial, call.price) : undefined;
          tokens = Math.max(r.tokens, tokensOf(partial));
          cost = r.usd === 'unknown' || reportedCost?.usd === 'unknown' ? { usd: 'unknown' } : { usd: Math.max(r.usd, reportedCost?.usd ?? 0) };
        }
        await store.add({ at: r.at, day: r.day, persona: r.persona, turn: r.turn, model: r.model, tokens, cost, reservation: r.id });
        return cost;
      });
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

/** A usage store in memory, for tests and until the journal's store exists. `pause` runs inside every call. */
export function memoryUsageStore(pause: () => Promise<void> = async () => {}): UsageStore & { readonly all: readonly UsageRecord[]; readonly reservations: readonly Reservation[] } {
  const all: UsageRecord[] = [];
  const reservations: Reservation[] = [];
  return {
    all,
    reservations,
    async add(record) { await pause(); all.push(record); },
    async records(day) { await pause(); return all.filter((r) => day === undefined || r.day === day); },
    async reserve(r) { await pause(); reservations.push(r); },
    async release(id) {
      await pause();
      const i = reservations.findIndex((r) => r.id === id);
      if (i >= 0) reservations.splice(i, 1);
    },
    async open() { await pause(); return [...reservations]; }
  };
}
