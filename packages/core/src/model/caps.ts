// Caps on what model calls may spend. A pure unit: the clock and the usage store are passed in (the real
// store arrives with the journal in step 5). The turn loop asks `before` ahead of every call and tells
// `after` what each call used.
//
//   - Each reply's length is capped: `before` gives the max output tokens to send.
//   - Tokens per turn and per day, across every persona.
//   - A cost where the model's price is known. A cost it can't price is 'unknown', never $0, and is
//     counted by its tokens.
//   - An optional daily spending cap per persona, checked against today's spend plus the call's longest
//     possible cost. Over it, the call pauses: `before` says so plainly, and nothing is sent.

import type { ModelRequest, Usage } from './port.ts';

/** US dollars per million tokens. A cache price left out is unknown, not free. */
export interface Price {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok?: number;
  readonly cacheWritePerMTok?: number;
}

export type Cost = { readonly usd: number } | { readonly usd: 'unknown' };

export function costOf(usage: Usage, price: Price | undefined): Cost {
  if (!price) return { usd: 'unknown' };
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  if ((read > 0 && price.cacheReadPerMTok === undefined) || (write > 0 && price.cacheWritePerMTok === undefined)) return { usd: 'unknown' };
  const plain = Math.max(0, usage.inputTokens - read - write);
  const usd =
    (plain * price.inputPerMTok + read * (price.cacheReadPerMTok ?? 0) + write * (price.cacheWritePerMTok ?? 0) + usage.outputTokens * price.outputPerMTok) / 1e6;
  return { usd };
}

export interface UsageRecord {
  readonly at: number;
  /** The local day it counts toward, YYYY-MM-DD. */
  readonly day: string;
  readonly persona: string;
  readonly model: string;
  readonly tokens: number;
  readonly cost: Cost;
}

export interface DayTotals {
  readonly tokens: number;
  /** The priced spend. */
  readonly usd: number;
  /** How many records had no price. */
  readonly unpriced: number;
}

export interface UsageStore {
  add(record: UsageRecord): Promise<void>;
  /** One day's totals, for one persona or (without one) for all. */
  totals(day: string, persona?: string): Promise<DayTotals>;
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
  | { readonly go: true; readonly maxOutputTokens: number }
  | { readonly go: false; readonly pause: PauseReason; readonly message: string };

export interface CallInfo {
  readonly request: ModelRequest;
  readonly persona: string;
  /** Tokens this turn has used so far. */
  readonly turnTokens: number;
  readonly price: Price | undefined;
}

/**
 * Input tokens a request could cost, before it's sent: a character count over three. Ordinary English
 * runs near four characters a token, so this errs high, which is the safe side for a cap.
 */
export function estimateInputTokens(request: ModelRequest): number {
  const chars =
    request.system.length + JSON.stringify(request.messages).length + JSON.stringify(request.tools).length;
  return Math.ceil(chars / 3);
}

/** The local calendar day of a moment, YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export interface Caps {
  before(call: CallInfo): Promise<CapCheck>;
  /** Records what a call used. Returns its cost. */
  after(call: { persona: string; model: string; usage: Usage; price: Price | undefined }): Promise<Cost>;
}

export function createCaps(config: CapsConfig, store: UsageStore, clock: Clock, dayOf: (ms: number) => string = localDay): Caps {
  return {
    async before({ request, persona, turnTokens, price }) {
      const maxOutputTokens = Math.max(1, Math.min(request.maxOutputTokens ?? config.maxReplyTokens, config.maxReplyTokens));
      const input = estimateInputTokens(request);
      const longest = input + maxOutputTokens;
      const day = dayOf(clock.now());
      if (config.maxTurnTokens !== undefined && turnTokens + longest > config.maxTurnTokens) {
        return {
          go: false,
          pause: 'turn-tokens',
          message: `This turn has used ${turnTokens} tokens. One more reply could take it past its cap of ${config.maxTurnTokens}.`
        };
      }
      if (config.maxDayTokens !== undefined) {
        const all = await store.totals(day);
        if (all.tokens + longest > config.maxDayTokens) {
          return {
            go: false,
            pause: 'day-tokens',
            message: `Today has used ${all.tokens} tokens. One more reply could take it past the daily cap of ${config.maxDayTokens}.`
          };
        }
      }
      const cap = config.personaDayUsd?.[persona];
      if (cap !== undefined) {
        const mine = await store.totals(day, persona);
        const worst = costOf({ inputTokens: input, outputTokens: maxOutputTokens }, price);
        if (worst.usd === 'unknown' || mine.unpriced > 0) {
          return {
            go: false,
            pause: 'persona-unpriced',
            message: `This persona has a daily cap of ${usd(cap)}, but ${worst.usd === 'unknown' ? "this model's price isn't known" : 'some of today\'s use had no known price'}, so the cap can't be kept. Add the model's price, or remove the cap.`
          };
        }
        if (mine.usd + worst.usd > cap) {
          return {
            go: false,
            pause: 'persona-day-usd',
            message: `This persona has spent ${usd(mine.usd)} today. One more reply could cost up to ${usd(worst.usd)}, past its daily cap of ${usd(cap)}.`
          };
        }
      }
      return { go: true, maxOutputTokens };
    },

    async after({ persona, model, usage, price }) {
      const cost = costOf(usage, price);
      const at = clock.now();
      await store.add({ at, day: dayOf(at), persona, model, tokens: usage.inputTokens + usage.outputTokens, cost });
      return cost;
    }
  };
}

/** A usage store in memory, for tests and until the journal's store exists. */
export function memoryUsageStore(): UsageStore & { readonly records: readonly UsageRecord[] } {
  const records: UsageRecord[] = [];
  return {
    records,
    async add(record) {
      records.push(record);
    },
    async totals(day, persona) {
      const mine = records.filter((r) => r.day === day && (persona === undefined || r.persona === persona));
      return {
        tokens: mine.reduce((n, r) => n + r.tokens, 0),
        usd: mine.reduce((n, r) => n + (r.cost.usd === 'unknown' ? 0 : r.cost.usd), 0),
        unpriced: mine.filter((r) => r.cost.usd === 'unknown').length
      };
    }
  };
}
