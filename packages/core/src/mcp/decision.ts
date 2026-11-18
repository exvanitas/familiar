// Consent bound to the exact call (docs/mcp-design.md 5.5). A `ToolDecision` is opaque: it has a type
// brand, its constructor isn't exported, and every minted one lives in a module-private WeakSet, so a cast
// object or a copy is never genuine. Only the gate mints one (journal.ts, inside the tool's execute), from
// durable facts: a standing "always" for exactly this identity and both fingerprints while the request
// carries no outside content, or the person's Yes on a card whose stored facts match this call now. A
// decision is used once: `send` (client.ts) marks it used in the same synchronous step as its handoff.

import { canonicalJson, sha256 } from './hash.ts';

declare const brand: unique symbol;

/** What a card shows, and what a decision is bound to: stored when the card is made. */
export interface CardFacts {
  /** The server's immutable id. */
  readonly server: string;
  /** The tool's own name on its server. */
  readonly tool: string;
  /** The run the call is for, and the launch (setup fingerprint) it started from. */
  readonly run: string;
  readonly launch: string;
  /** The tool's fingerprint as listed. */
  readonly fingerprint: string;
  /** The arguments in the canonical form, and its SHA-256. */
  readonly canonical: string;
  readonly hash: string;
}

export interface ToolDecision extends CardFacts {
  readonly [brand]: true;
  /** The step (tool task) it's bound to. */
  readonly step: string;
  /** How it was minted: a standing "always", or the person's Yes to this call. */
  readonly by: 'always' | 'asked';
  /** Whether the request that made the call carried outside content (never with "always"). */
  readonly outside: boolean;
}

const minted = new WeakSet<object>();
const used = new WeakSet<object>();

/** Arguments outside plain JSON (a function, a non-finite number, a date, a cycle) are refused. */
export function plainJson(v: unknown, seen: Set<unknown> = new Set()): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'object' || seen.has(v)) return false;
  seen.add(v);
  if (Array.isArray(v)) return v.every((x) => plainJson(x, seen));
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false;
  return Object.values(v as Record<string, unknown>).every((x) => x === undefined || plainJson(x, seen));
}

/** The one canonical form: the card, the stored answer, the mint and the body all use it. */
export function canonicalArguments(args: unknown): { readonly canonical: string; readonly hash: string } | undefined {
  if (!plainJson(args ?? {})) return undefined;
  const canonical = canonicalJson(args ?? {});
  return { canonical, hash: sha256(canonical) };
}

/** The facts must match on every field. */
export function sameFacts(a: CardFacts, b: CardFacts): boolean {
  return a.server === b.server && a.tool === b.tool && a.run === b.run && a.launch === b.launch && a.fingerprint === b.fingerprint && a.canonical === b.canonical && a.hash === b.hash;
}

/**
 * Mints a decision. For the gate only: a module-graph test fails on any other importer outside tests.
 * "Always" is never minted for a request with outside content.
 */
export function mintDecision(facts: CardFacts, step: string, by: 'always' | 'asked', outside: boolean): ToolDecision | undefined {
  if (by === 'always' && outside) return undefined;
  const d = Object.freeze({ ...facts, step, by, outside }) as ToolDecision;
  minted.add(d);
  return d;
}

/** Genuine (minted here) and not yet used. */
export function usable(d: unknown): d is ToolDecision {
  return typeof d === 'object' && d !== null && minted.has(d) && !used.has(d);
}

/** Marks it used. Called only by send, in the same step as the handoff. */
export function markUsed(d: ToolDecision): void {
  used.add(d);
}
