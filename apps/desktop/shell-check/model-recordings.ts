/* Recorded model replies for the model port contract, served by the Node tests' fake endpoint
   (tests/model/server.ts) and by the runner's net-server.mjs. Hand-built from each API's documented
   wire format; no real endpoint produced them, and no key or paid call was used. The text, the tool
   call and the numbers match model-contract.ts. Every error body holds ENDPOINT_WORDS, and `{{key}}`
   where an endpoint might echo the key it got: the server puts the request's key there, so a check can
   see whether it comes back.

   Where each format comes from:
   - OpenAI chat completions, streaming: platform.openai.com/docs/api-reference/chat-streaming (chunks,
     `finish_reason` stop, length, tool_calls and content_filter, `usage` with
     `prompt_tokens_details.cached_tokens`), and /docs/guides/error-codes for the 401, 429, 500 and 503
     bodies. The thinking case is OpenRouter's extension of the same wire: `reasoning` text and
     `reasoning_details` with a signature, openrouter.ai/docs/use-cases/reasoning-tokens ("Preserving
     reasoning blocks").
   - Anthropic Messages, streaming: docs.anthropic.com/en/docs/build-with-claude/streaming (events,
     `thinking_delta`, `signature_delta`, `input_json_delta`), /extended-thinking for signed thinking
     sent back with tool results, /prompt-caching for `cache_read_input_tokens` and
     `cache_creation_input_tokens`, /api/errors for 401, 429, 500 and 529 and their bodies, and the
     `refusal` stop reason. `x-should-retry` is a header the API sends with its errors.
   - Gemini through Google's OpenAI-compatible endpoint: ai.google.dev/gemini-api/docs/openai (the
     OpenAI chunk shape, errors sent as a one-item list of Google's error object) and
     /docs/thought-signatures ("OpenAI compatibility": the signature rides on a tool call as
     `extra_content.google.thought_signature`). Taken from the docs, not checked against the live
     endpoint; the spike said so too. Cache reads are reported as `cached_tokens`, as in OpenAI's. */
import { CONTRACT_CACHE, CONTRACT_TEXT, CONTRACT_THINKING, ENDPOINT_WORDS } from '@familiar/core/testing';

export type Wire = 'openai' | 'anthropic' | 'gemini';
export const WIRES: readonly Wire[] = ['openai', 'anthropic', 'gemini'];

export interface Recording {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Written one by one, `delayMs` apart. For SSE each is one whole event block. */
  readonly chunks: readonly string[];
  readonly delayMs: number;
  /** The request must carry back this wire's replay, in its proper place (`carriesReplay`), or the
      wire's bad-request recording answers instead. */
  readonly replay?: true;
  /** Goes quiet for `ms` after writing `after` chunks. */
  readonly stall?: { readonly after: number; readonly ms: number };
  /** For a redirect: where to, relative to the scenario (see `answer`). */
  readonly redirectTo?: Scenario;
}

const sse = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };
const json = { 'content-type': 'application/json' };
const data = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const event = (name: string, value: unknown): string => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
const reply = (chunks: string[], headers: Record<string, string> = sse, delayMs = 5): Recording => ({ status: 200, headers, chunks, delayMs });
const failure = (status: number, body: unknown, headers: Record<string, string> = {}): Recording => ({ status, headers: { ...json, ...headers }, chunks: [JSON.stringify(body)], delayMs: 0 });

const TEXT_PIECES = ['Hello', ' there.', ' This is the', ' contract reply.'];
if (TEXT_PIECES.join('') !== CONTRACT_TEXT) throw new Error('the recorded text drifted from CONTRACT_TEXT');
const SLOW_PIECES = Array.from({ length: 40 }, (_, i) => `word${i} `);
const THINK_PIECES = ['They want the time. ', 'Use get_time.'];
if (THINK_PIECES.join('') !== CONTRACT_THINKING) throw new Error('the recorded thinking drifted from CONTRACT_THINKING');
const BAD_ARGS = '{"zone": UTC}';

export const SIGNATURES: Record<Wire, string> = {
  openai: 'or-recorded-reasoning-signature',
  anthropic: 'EqQBCgIYAhIM-recorded-signature',
  gemini: 'gm-recorded-thought-signature'
};

export type Scenario =
  | 'text' | 'tool-call' | 'auth-error' | 'slow' | 'thinking-tool-call' | 'replay-check' | 'bad-tool-arguments'
  | 'cache' | 'length' | 'filtered' | 'rate-limit' | 'overloaded' | 'server-error' | 'bad-request'
  | 'unavailable' | 'redirected-rate-limit' | 'unsafe-tool-arguments' | 'no-usage' | 'stream-timeout' | 'stream-too-large';

/** The tool call ids the thinking recordings use, which a replayed signature must ride on. */
export const REPLAY_CALL_IDS: Record<Wire, string> = { openai: 'call_rec_1', anthropic: 'toolu_rec_2', gemini: 'function-call-15409270000000000000' };
const BIG_PIECES = Array.from({ length: 80 }, (_, i) => `chunk ${i} `.padEnd(100, 'x'));
const redirect = (to: Scenario): Recording => ({ status: 302, headers: { 'content-length': '0' }, chunks: [], delayMs: 0, redirectTo: to });

/* ---------- OpenAI chat completions (and the OpenAI-compatible endpoints) ---------- */

function openaiShaped(wire: 'openai' | 'gemini'): Record<Scenario, Recording> {
  const chunk = (delta: unknown, finish: string | null = null) =>
    data({ id: 'chatcmpl-rec1', object: 'chat.completion.chunk', created: 1731571200, model: 'contract-model', choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
  const usage = (prompt: number, completion: number, cached?: number) =>
    data({
      id: 'chatcmpl-rec1', object: 'chat.completion.chunk', created: 1731571200, model: 'contract-model', choices: [],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}) }
    });
  const done = 'data: [DONE]\n\n';
  const text = (finish = 'stop', u = usage(31, 9)) => [chunk({ role: 'assistant', content: '' }), ...TEXT_PIECES.map(t => chunk({ content: t })), chunk({}, finish), u, done];
  // OpenAI's errors are one object; Google's compatible endpoint sends a one-item list of its own.
  const err = (status: number, openai: unknown, google: { code: number; status: string; message: string }, headers: Record<string, string> = {}) =>
    failure(status, wire === 'openai' ? openai : [{ error: { ...google, message: `${google.message} ${ENDPOINT_WORDS}` } }], headers);
  const callId = wire === 'openai' ? 'call_rec_1' : 'function-call-15409270000000000000';
  const thinkingCall: string[] = wire === 'openai'
    ? [
        chunk({ role: 'assistant', content: '', reasoning: THINK_PIECES[0], reasoning_details: [{ type: 'reasoning.text', text: THINK_PIECES[0], format: 'anthropic-claude-v1', index: 0 }] }),
        chunk({ reasoning: THINK_PIECES[1], reasoning_details: [{ type: 'reasoning.text', text: THINK_PIECES[1], signature: SIGNATURES.openai, format: 'anthropic-claude-v1', index: 0 }] }),
        chunk({ tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'get_time', arguments: '{"zone": "UTC"}' } }] }),
        chunk({}, 'tool_calls'), usage(48, 30), done
      ]
    : [
        // Gemini sends a call whole, with its thought signature beside it.
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'get_time', arguments: '{"zone":"UTC"}' }, extra_content: { google: { thought_signature: SIGNATURES.gemini } } }] }, 'tool_calls'),
        usage(48, 6), done
      ];
  const badRequest = err(400,
    { error: { message: `Invalid request: the reasoning or signature is missing. ${ENDPOINT_WORDS}`, type: 'invalid_request_error', param: 'messages', code: null } },
    { code: 400, status: 'INVALID_ARGUMENT', message: 'Function call is missing a thought_signature.' });
  return {
    text: reply(text()),
    'tool-call': reply(wire === 'openai'
      ? [
          chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'get_time', arguments: '' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '{"zo' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: 'ne": "UTC"}' } }] }),
          chunk({}, 'tool_calls'), usage(48, 15), done
        ]
      : [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'get_time', arguments: '{"zone":"UTC"}' } }] }, 'tool_calls'), usage(48, 6), done]),
    'auth-error': wire === 'openai'
      ? failure(401, { error: { message: `Incorrect API key provided: {{key}}. ${ENDPOINT_WORDS}`, type: 'invalid_request_error', param: null, code: 'invalid_api_key' } })
      // A bad Gemini key is a 400 with reason API_KEY_INVALID, not a 401.
      : failure(400, [{ error: { code: 400, message: `API key not valid. Please pass a valid API key. {{key}} ${ENDPOINT_WORDS}`, status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } }]),
    slow: reply([chunk({ role: 'assistant', content: '' }), ...SLOW_PIECES.map(t => chunk({ content: t })), chunk({}, 'stop'), done], sse, 100),
    'thinking-tool-call': reply(thinkingCall),
    'replay-check': { ...reply(text()), replay: true },
    'unsafe-tool-arguments': reply([
      chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'get_time', arguments: '{"toString": null}' } }] }),
      chunk({}, 'tool_calls'), usage(48, 7), done
    ]),
    // A server that doesn't send stream usage: no usage chunk at all.
    'no-usage': reply([chunk({ role: 'assistant', content: '' }), ...TEXT_PIECES.map(t => chunk({ content: t })), chunk({}, 'stop'), done]),
    'stream-timeout': { ...reply(text()), stall: { after: 2, ms: 4000 } },
    'stream-too-large': reply([chunk({ role: 'assistant', content: '' }), ...BIG_PIECES.map(t => chunk({ content: t })), chunk({}, 'stop'), usage(31, 900), done], sse, 2),
    'redirected-rate-limit': redirect('rate-limit'),
    'bad-request': badRequest,
    'bad-tool-arguments': reply([
      chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'get_time', arguments: BAD_ARGS } }] }),
      chunk({}, 'tool_calls'), usage(48, 7), done
    ]),
    cache: reply(text('stop', usage(CONTRACT_CACHE.inputTokens, 9, CONTRACT_CACHE.cacheReadTokens))),
    length: reply([chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hello' }), chunk({}, 'length'), usage(31, 1), done]),
    filtered: reply([chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hello' }), chunk({}, 'content_filter'), usage(31, 1), done]),
    'rate-limit': err(429,
      { error: { message: `Rate limit reached for requests. ${ENDPOINT_WORDS}`, type: 'requests', param: null, code: 'rate_limit_exceeded' } },
      { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).' }, { 'retry-after': '2' }),
    // OpenAI's and Google's documented 503s carry no sign the request wasn't taken. This one adds
    // `x-should-retry: true`, which OpenAI's own SDK honours, to test the adapter's rule; whether either
    // sends it isn't documented.
    overloaded: err(503,
      { error: { message: `The engine is currently overloaded, please try again later. ${ENDPOINT_WORDS}`, type: 'server_error', param: null, code: null } },
      { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.' }, { 'x-should-retry': 'true' }),
    unavailable: err(503,
      { error: { message: `The engine is currently overloaded, please try again later. ${ENDPOINT_WORDS}`, type: 'server_error', param: null, code: null } },
      { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.' }),
    'server-error': err(500,
      { error: { message: `The server had an error while processing your request. ${ENDPOINT_WORDS}`, type: 'server_error', param: null, code: null } },
      { code: 500, status: 'INTERNAL', message: 'An internal error has occurred.' })
  };
}

/* ---------- Anthropic Messages ---------- */

function anthropicWire(): Record<Scenario, Recording> {
  const start = (input: number, cacheRead = 0, cacheWrite = 0) =>
    event('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_rec_1', type: 'message', role: 'assistant', model: 'contract-model', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: 1 }
      }
    });
  const textStart = (index = 0) => event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
  const textDelta = (text: string, index = 0) => event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
  const blockStop = (index = 0) => event('content_block_stop', { type: 'content_block_stop', index });
  const end = (reason: string, output: number) => [
    event('message_delta', { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: output } }),
    event('message_stop', { type: 'message_stop' })
  ];
  const head = (n: number) => ({ ...sse, 'request-id': `req_rec_${n}` });
  const text = (startEvent = start(31)) => [startEvent, textStart(), event('ping', { type: 'ping' }), ...TEXT_PIECES.map(t => textDelta(t)), blockStop(), ...end('end_turn', 9)];
  const toolUse = (index: number, id: string, pieces: string[]) => [
    event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'get_time', input: {} } }),
    ...pieces.map(p => event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: p } })),
    blockStop(index)
  ];
  const err = (status: number, type: string, message: string, headers: Record<string, string>) =>
    failure(status, { type: 'error', error: { type, message: `${message} ${ENDPOINT_WORDS}` } }, { 'request-id': `req_rec_err${status}`, ...headers });
  return {
    text: reply(text(), head(1)),
    'tool-call': reply([start(48), ...toolUse(0, 'toolu_rec_1', ['', '{"zo', 'ne": "UTC"}']), ...end('tool_use', 15)], head(2)),
    'auth-error': err(401, 'authentication_error', 'invalid x-api-key {{key}}', { 'x-should-retry': 'false' }),
    slow: reply([start(31), textStart(), ...SLOW_PIECES.map(t => textDelta(t)), blockStop(), ...end('end_turn', 40)], head(4), 100),
    'thinking-tool-call': reply([
      start(48),
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      ...THINK_PIECES.map(t => event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } })),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIGNATURES.anthropic } }),
      blockStop(0),
      ...toolUse(1, 'toolu_rec_2', ['{"zone": "UTC"}']),
      ...end('tool_use', 30)
    ], head(5)),
    'replay-check': { ...reply(text(), head(6)), replay: true },
    'unsafe-tool-arguments': reply([start(48), ...toolUse(0, 'toolu_rec_4', ['{"toString": null}']), ...end('tool_use', 7)], head(11)),
    // message_delta without its usage, as a proxy might send it.
    'no-usage': reply([start(31), textStart(), ...TEXT_PIECES.map(t => textDelta(t)), blockStop(),
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }), event('message_stop', { type: 'message_stop' })], head(12)),
    'stream-timeout': { ...reply(text(), head(13)), stall: { after: 4, ms: 4000 } },
    'stream-too-large': reply([start(31), textStart(), ...BIG_PIECES.map(t => textDelta(t)), blockStop(), ...end('end_turn', 900)], head(14), 2),
    'redirected-rate-limit': redirect('rate-limit'),
    unavailable: err(503, 'api_error', 'Service unavailable', {}),
    // What Anthropic says when a turn mixing thinking and tools comes back without its signed thinking.
    'bad-request': err(400, 'invalid_request_error', 'messages.1.content.0.type: Expected `thinking` or `redacted_thinking`, but found `tool_use`.', { 'x-should-retry': 'false' }),
    'bad-tool-arguments': reply([start(48), ...toolUse(0, 'toolu_rec_3', [BAD_ARGS]), ...end('tool_use', 7)], head(7)),
    // 50 plain, 1200 read from the cache and 50 written: 1300 input in all.
    cache: reply(text(start(50, CONTRACT_CACHE.cacheReadTokens, CONTRACT_CACHE.inputTokens - CONTRACT_CACHE.cacheReadTokens - 50)), head(8)),
    length: reply([start(31), textStart(), textDelta('Hello'), blockStop(), ...end('max_tokens', 1)], head(9)),
    filtered: reply([start(31), textStart(), textDelta('Hello'), blockStop(), ...end('refusal', 1)], head(10)),
    'rate-limit': err(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit.', { 'retry-after': '2', 'x-should-retry': 'true' }),
    overloaded: err(529, 'overloaded_error', 'Overloaded', { 'x-should-retry': 'true' }),
    'server-error': err(500, 'api_error', 'Internal server error', {})
  };
}

export const recordings: Record<Wire, Record<Scenario, Recording>> = {
  openai: openaiShaped('openai'),
  anthropic: anthropicWire(),
  gemini: openaiShaped('gemini')
};

/* The key a request carried, as the endpoint would read it. */
export function keyOf(headers: Readonly<Record<string, string | string[] | undefined>>): string {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  return one(headers['x-api-key']) || one(headers['authorization']).replace(/^Bearer /, '');
}

/**
 * What to answer for a request: `path` is /<wire>/<scenario>/<whatever the SDK added>, after the part
 * of the path the server itself owns. `body` is the request's body as text.
 */
export function answer(path: string, body: string, key: string): Recording | undefined {
  const [, wire, scenario, ...rest] = path.split('/');
  const r = recordings[wire as Wire]?.[scenario as Scenario];
  if (!r) return undefined;
  if (r.redirectTo) {
    // Relative, so it stays under whatever prefix the server put in front: up past what the SDK added.
    const location = '../'.repeat(rest.length) + [r.redirectTo, ...rest].join('/');
    return { ...r, headers: { ...r.headers, location } };
  }
  const chosen = r.replay && !carriesReplay(wire as Wire, body) ? recordings[wire as Wire]['bad-request'] : r;
  return { ...chosen, chunks: chosen.chunks.map(c => c.replaceAll('{{key}}', key)) };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Whether a request carries back the thinking-tool-call reply's replay in the place each API reads it:
 * - Anthropic: in the assistant turn, a thinking block with the signature, before the tool_use block of
 *   the recorded call.
 * - OpenRouter's wire: on the assistant message, `reasoning_details` holding an entry with the signature.
 * - Gemini: on the recorded tool call, `extra_content.google.thought_signature`, and on no other call.
 * The signature anywhere else, as text or on the wrong call, doesn't count.
 */
export function carriesReplay(wire: Wire, body: string): boolean {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return false;
  }
  const sig = SIGNATURES[wire], id = REPLAY_CALL_IDS[wire];
  const turns = arr(obj(j)?.messages).map(obj).filter((m): m is Json => m?.role === 'assistant');
  return turns.some(m => {
    if (wire === 'anthropic') {
      const blocks = arr(m.content).map(obj);
      const thinking = blocks.findIndex(b => b?.type === 'thinking' && b.signature === sig);
      const call = blocks.findIndex(b => b?.type === 'tool_use' && b.id === id);
      return thinking >= 0 && call > thinking;
    }
    if (wire === 'openai') return arr(m.reasoning_details).some(d => obj(d)?.signature === sig);
    const calls = arr(m.tool_calls).map(obj);
    const signed = calls.filter(c => obj(obj(c?.extra_content)?.google)?.thought_signature === sig);
    return signed.length === 1 && signed[0]!.id === id;
  });
}

/** The guarded fetch's limits a harness sets for the scenarios that test them. */
export const TRANSPORT_LIMITS: Partial<Record<Scenario, { readonly idleMs?: number; readonly maxBytes?: number }>> = {
  'stream-timeout': { idleMs: 1000 },
  'stream-too-large': { maxBytes: 4096 }
};
