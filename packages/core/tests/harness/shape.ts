// The harness's own reading of what the client's parser accepts (3.10), and so of where it stops reading an
// answer: shared by the fake exe, the catalog reading and the checks. Never the parser itself.

import type { Plan } from './wire.ts';

type Msg = Record<string, any>;

/** Whether 3.10's shape rules reject a message, as the harness reads them, never importing the parser: an
    object, nested at most 64 deep, with `jsonrpc: "2.0"`; a request or notification with a method string of
    at most 128 bytes, `params` an object if present, a request's id a string of at most 128 bytes or a safe
    integer; a response with such an id and exactly one of `result` (an object) or `error` (an integer code
    and a string message). */
export function rejectedByShape(m: unknown): boolean {
  const object = (v: unknown): v is Msg => v !== null && typeof v === 'object' && !Array.isArray(v);
  const within = (v: unknown, depth: number): boolean => depth <= 64 && (Array.isArray(v) ? v.every((x) => within(x, depth + 1)) : object(v) ? Object.values(v).every((x) => within(x, depth + 1)) : true);
  const id = (v: unknown) => (typeof v === 'string' ? Buffer.byteLength(v) <= 128 : Number.isSafeInteger(v));
  if (!object(m) || !within(m, 1) || m.jsonrpc !== '2.0') return true;
  if ('method' in m) {
    if (typeof m.method !== 'string' || Buffer.byteLength(m.method) > 128) return true;
    if (m.params !== undefined && !object(m.params)) return true;
    return 'id' in m && !id(m.id);
  }
  if (!('id' in m) || !id(m.id) || 'result' in m === 'error' in m) return true;
  if ('result' in m) return !object(m.result);
  return !object(m.error) || !Number.isInteger(m.error.code) || typeof m.error.message !== 'string';
}

/** The messages of an answer the client's parser read: up to and including the first of its final response
    (the plan's `final`) or the first message 3.10's shape rules reject, whichever came first. It reads
    nothing after either, so what follows in the same chunk is never the client's. */
export function readPrefix(plan: Plan): Msg[] {
  const rejected = plan.messages.findIndex(rejectedByShape);
  const ends = [rejected, plan.final].filter((i) => i >= 0);
  return ends.length ? plan.messages.slice(0, Math.min(...ends) + 1) : plan.messages;
}

