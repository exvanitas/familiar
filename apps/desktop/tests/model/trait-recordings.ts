/* Recorded replies to the trait reader's call: the model answers with one set_traits tool call, in
   each API's wire format. Hand-built in the style of shell-check/model-recordings.ts, from the same
   docs (OpenAI chat completions streaming with tool_calls, Anthropic Messages streaming with tool_use
   and input_json_delta, Gemini's OpenAI-compatible endpoint sending a call whole). No real endpoint
   produced them. The answer is for the V2 fixture card (packages/cards/fixtures/cards/v2-pell.json):
   its quote is the card's own words, and one interest breaks the rules, so the check is seen to run. */
import type { Recording, Wire } from '../../shell-check/model-recordings.ts';

export const TRAIT_ARGUMENTS = {
  sociability: 'outgoing',
  closeness: 'warm',
  lively: 'unsure',
  interests: ['gardening', 'Rainy Days', '<b>weather</b>'],
  evidence: { sociability: 'cheerful, chatty, easily distracted' }
};

/** What readTraits gives for it, after the check. */
export const TRAIT_READING = {
  sociability: 'outgoing',
  closeness: 'warm',
  lively: 'any',
  interests: ['gardening', 'rainy days'],
  evidence: { sociability: 'cheerful, chatty, easily distracted' }
};

const sse = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };
const data = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const event = (name: string, value: unknown): string => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
const reply = (chunks: string[], headers: Record<string, string> = sse): Recording => ({ status: 200, headers, chunks, delayMs: 2 });

const ARGS = JSON.stringify(TRAIT_ARGUMENTS);
/** The arguments in three uneven pieces, as a streaming endpoint sends them. */
const PIECES = [ARGS.slice(0, 17), ARGS.slice(17, 60), ARGS.slice(60)];

function openaiShaped(wire: 'openai' | 'gemini'): Recording {
  const chunk = (delta: unknown, finish: string | null = null) =>
    data({ id: 'chatcmpl-traits1', object: 'chat.completion.chunk', created: 1731571200, model: 'contract-model', choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
  const usage = data({ id: 'chatcmpl-traits1', object: 'chat.completion.chunk', created: 1731571200, model: 'contract-model', choices: [], usage: { prompt_tokens: 640, completion_tokens: 58, total_tokens: 698 } });
  if (wire === 'gemini') {
    return reply([
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'function-call-traits-1', type: 'function', function: { name: 'set_traits', arguments: ARGS } }] }, 'tool_calls'),
      usage, 'data: [DONE]\n\n'
    ]);
  }
  return reply([
    chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_traits_1', type: 'function', function: { name: 'set_traits', arguments: '' } }] }),
    ...PIECES.map((p) => chunk({ tool_calls: [{ index: 0, function: { arguments: p } }] })),
    chunk({}, 'tool_calls'), usage, 'data: [DONE]\n\n'
  ]);
}

function anthropicWire(): Recording {
  return reply([
    event('message_start', {
      type: 'message_start',
      message: { id: 'msg_traits_1', type: 'message', role: 'assistant', model: 'contract-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 640, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } }
    }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_traits_1', name: 'set_traits', input: {} } }),
    ...['', ...PIECES].map((p) => event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: p } })),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 58 } }),
    event('message_stop', { type: 'message_stop' })
  ], { ...sse, 'request-id': 'req_traits_1' });
}

export const traitRecordings: Record<Wire, Recording> = {
  openai: openaiShaped('openai'),
  anthropic: anthropicWire(),
  gemini: openaiShaped('gemini')
};

/** For the test server: /<wire>/set-traits/... answers with that wire's recording. */
export function traitAnswer(path: string): Recording | undefined {
  const [, wire, scenario] = path.split('/');
  return scenario === 'set-traits' ? traitRecordings[wire as Wire] : undefined;
}
