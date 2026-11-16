// The trait reader's one call: a card's fields to the persona's own model, through the model port, with
// set_traits as the only tool. The answer is the tool call, or else one JSON object in the reply's text,
// and it goes through the strict check in @familiar/cards. Never throws. docs/persona-traits.md.
import { checkAnswer, readerPrompt, SET_TRAITS_TOOL, traitCacheKey, type Card, type Digest, type TraitReading } from '@familiar/cards';
import type { ModelErrorKind, ModelPort, ModelRequest } from '../model/port.ts';
import type { TraitCache } from './cache.ts';

/** The most reply text read when looking for a JSON answer. A real answer is a few hundred characters; a longer reply is no answer. */
export const MAX_ANSWER_CHARS = 16_000;
/** Room for the answer: five traits' worth of JSON and three quotes, with thinking models' slack. */
export const READER_MAX_OUTPUT_TOKENS = 1_024;

export interface ReadTraitsOptions {
  /** The persona's own chat model, as the endpoint knows it. */
  readonly model: string;
  /** Fills {{user}} in what's sent. */
  readonly userName: string;
  /** SHA-256, for the cache key: the webview's crypto.subtle. */
  readonly digest: Digest;
  readonly cache?: TraitCache;
  /** "Read her card again": makes the call even when the cache has this card. */
  readonly again?: boolean;
  readonly signal?: AbortSignal;
}

export type TraitFailure =
  | 'model-error' // the call ended in an error event (`error` says which kind)
  | 'no-answer' // no set_traits call, and no JSON object in the text
  | 'unreadable' // an answer that isn't an object
  | 'internal'; // hashing the card failed, or the port broke its promise and threw

export type TraitsResult =
  | { readonly ok: true; readonly reading: TraitReading; readonly key: string; readonly fromCache: boolean }
  | { readonly ok: false; readonly reason: TraitFailure; readonly key?: string; readonly error?: ModelErrorKind };

export async function readTraits(card: Card, model: ModelPort, options: ReadTraitsOptions): Promise<TraitsResult> {
  try {
    return await read(card, model, options);
  } catch {
    // Nothing in `read` is known to throw: a cache or port that breaks its promise is caught there too.
    return { ok: false, reason: 'internal' };
  }
}

async function read(card: Card, model: ModelPort, options: ReadTraitsOptions): Promise<TraitsResult> {
  let key: string;
  try {
    key = await traitCacheKey(card, options.digest);
  } catch {
    return { ok: false, reason: 'internal' };
  }
  if (options.cache && !options.again) {
    const cached = await Promise.resolve().then(() => options.cache!.get(key)).catch(() => undefined);
    if (cached) return { ok: true, reading: cached, key, fromCache: true };
  }
  const prompt = readerPrompt(card, { userName: options.userName });
  const request: ModelRequest = {
    model: options.model,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    tools: [SET_TRAITS_TOOL],
    maxOutputTokens: READER_MAX_OUTPUT_TOKENS,
    temperature: 0
  };
  let text = '';
  let cutShort = false;
  let args: unknown;
  let called = false;
  try {
    for await (const event of model.stream(request, options.signal)) {
      if (event.type === 'text') {
        if (text.length + event.delta.length > MAX_ANSWER_CHARS) cutShort = true;
        text += event.delta.slice(0, MAX_ANSWER_CHARS - text.length);
      } else if (event.type === 'tool-call') {
        if (!called && event.call.name === SET_TRAITS_TOOL.name) {
          called = true;
          args = event.call.arguments;
        }
      } else if (event.type === 'error') {
        return { ok: false, reason: 'model-error', key, error: event.error.kind };
      } else if (event.type === 'done') break;
    }
  } catch {
    return { ok: false, reason: 'internal', key };
  }
  // Text past the cap was never seen, so it could hold a second answer: the text fallback needs it all.
  const raw = called ? args : cutShort ? undefined : oneJsonObject(text);
  if (raw === undefined) return { ok: false, reason: 'no-answer', key };
  const reading = checkAnswer(raw, prompt.quotable);
  if (!reading) return { ok: false, reason: 'unreadable', key };
  if (options.cache) await Promise.resolve().then(() => options.cache!.set(key, reading)).catch(() => undefined);
  return { ok: true, reading, key, fromCache: false };
}

/**
 * The one JSON object in a reply's text, fenced or not. Undefined when there's none, it doesn't
 * parse, or a second object follows: two answers are no answer.
 */
export function oneJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  const end = objectEnd(text, start);
  if (end < 0) return undefined;
  if (text.indexOf('{', end) >= 0) return undefined;
  try {
    return JSON.parse(text.slice(start, end));
  } catch {
    return undefined;
  }
}

/** Just past the `}` that closes the object at `start`, or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0, inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}
