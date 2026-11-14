// Hand-written replies in each provider's documented wire format. No real endpoint produced these.
// The text and tool call match the model port contract (CONTRACT_TEXT, CONTRACT_TOOL_CALL).
//
// OpenAI chat completions: https://platform.openai.com/docs/api-reference/chat-streaming
// Anthropic messages: https://docs.anthropic.com/en/docs/build-with-claude/streaming
// Gemini streamGenerateContent (alt=sse): https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
// Gemini through its OpenAI-compatible endpoint: https://ai.google.dev/gemini-api/docs/openai

export type Wire = 'openai' | 'anthropic' | 'gemini' | 'gemini-openai';
export type Scenario = 'text' | 'tool-call' | 'auth-error' | 'slow';

export interface Recording {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Written one by one, `delayMs` apart. For SSE each is one whole event block. */
  readonly chunks: readonly string[];
  readonly delayMs: number;
}

const sse = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };
const json = { 'content-type': 'application/json' };

const data = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const event = (name: string, value: unknown): string => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;

// The contract text, split as a model might send it.
const TEXT_PIECES = ['Hello', ' there.', ' This is the', ' contract reply.'];
const SLOW_PIECES = Array.from({ length: 40 }, (_, i) => `word${i} `);

// ---- OpenAI chat completions ----

const oaChunk = (delta: unknown, finish: string | null = null) =>
  data({
    id: 'chatcmpl-rec1',
    object: 'chat.completion.chunk',
    created: 1731571200,
    model: 'contract-model',
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }]
  });
const oaUsage = (prompt: number, completion: number) =>
  data({
    id: 'chatcmpl-rec1',
    object: 'chat.completion.chunk',
    created: 1731571200,
    model: 'contract-model',
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
  });

const openai: Record<Scenario, Recording> = {
  text: {
    status: 200,
    headers: sse,
    delayMs: 5,
    chunks: [
      oaChunk({ role: 'assistant', content: '' }),
      ...TEXT_PIECES.map((t) => oaChunk({ content: t })),
      oaChunk({}, 'stop'),
      oaUsage(31, 9),
      'data: [DONE]\n\n'
    ]
  },
  'tool-call': {
    status: 200,
    headers: sse,
    delayMs: 5,
    chunks: [
      oaChunk({
        role: 'assistant',
        content: null,
        tool_calls: [{ index: 0, id: 'call_rec_1', type: 'function', function: { name: 'get_time', arguments: '' } }]
      }),
      oaChunk({ tool_calls: [{ index: 0, function: { arguments: '{"zo' } }] }),
      oaChunk({ tool_calls: [{ index: 0, function: { arguments: 'ne": "UTC"}' } }] }),
      oaChunk({}, 'tool_calls'),
      oaUsage(48, 15),
      'data: [DONE]\n\n'
    ]
  },
  'auth-error': {
    status: 401,
    headers: json,
    delayMs: 0,
    chunks: [
      JSON.stringify({
        error: {
          message: 'Incorrect API key provided: sk-bad-***-key. You can find your API key at https://platform.openai.com/account/api-keys.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_api_key'
        }
      })
    ]
  },
  slow: {
    status: 200,
    headers: sse,
    delayMs: 100,
    chunks: [
      oaChunk({ role: 'assistant', content: '' }),
      ...SLOW_PIECES.map((t) => oaChunk({ content: t })),
      oaChunk({}, 'stop'),
      'data: [DONE]\n\n'
    ]
  }
};

// ---- Anthropic messages ----

const anStart = (input: number, cacheRead = 0) =>
  event('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_rec_1',
      type: 'message',
      role: 'assistant',
      model: 'contract-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: 1 }
    }
  });
const anTextDelta = (text: string) =>
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const anStop = (reason: string, output: number) => [
  event('content_block_stop', { type: 'content_block_stop', index: 0 }),
  event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: output }
  }),
  event('message_stop', { type: 'message_stop' })
];

const anthropic: Record<Scenario, Recording> = {
  text: {
    status: 200,
    headers: { ...sse, 'request-id': 'req_rec_1' },
    delayMs: 5,
    chunks: [
      anStart(31),
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      event('ping', { type: 'ping' }),
      ...TEXT_PIECES.map(anTextDelta),
      ...anStop('end_turn', 9)
    ]
  },
  'tool-call': {
    status: 200,
    headers: { ...sse, 'request-id': 'req_rec_2' },
    delayMs: 5,
    chunks: [
      anStart(48),
      event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_rec_1', name: 'get_time', input: {} }
      }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '' } }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"zo' } }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ne": "UTC"}' } }),
      ...anStop('tool_use', 15)
    ]
  },
  'auth-error': {
    status: 401,
    headers: { ...json, 'request-id': 'req_rec_3', 'x-should-retry': 'false' },
    delayMs: 0,
    chunks: [JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })]
  },
  slow: {
    status: 200,
    headers: { ...sse, 'request-id': 'req_rec_4' },
    delayMs: 100,
    chunks: [
      anStart(31),
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ...SLOW_PIECES.map(anTextDelta),
      ...anStop('end_turn', 40)
    ]
  }
};

// ---- Gemini (native streamGenerateContent with alt=sse) ----

const gmChunk = (parts: unknown[], finish?: string, usage?: { prompt: number; out: number }) =>
  data({
    candidates: [{ content: { parts, role: 'model' }, ...(finish ? { finishReason: finish } : {}), index: 0 }],
    ...(usage
      ? { usageMetadata: { promptTokenCount: usage.prompt, candidatesTokenCount: usage.out, totalTokenCount: usage.prompt + usage.out } }
      : {}),
    modelVersion: 'contract-model',
    responseId: 'rec-gemini-1'
  });

// A bad Gemini API key comes back as HTTP 400 INVALID_ARGUMENT with reason API_KEY_INVALID, not 401.
const geminiBadKey = {
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'API_KEY_INVALID',
        domain: 'googleapis.com',
        metadata: { service: 'generativelanguage.googleapis.com' }
      }
    ]
  }
};

const gemini: Record<Scenario, Recording> = {
  text: {
    status: 200,
    headers: sse,
    delayMs: 5,
    chunks: [
      gmChunk([{ text: TEXT_PIECES[0] + TEXT_PIECES[1] }]),
      gmChunk([{ text: TEXT_PIECES[2] + TEXT_PIECES[3] }], 'STOP', { prompt: 31, out: 9 })
    ]
  },
  'tool-call': {
    status: 200,
    headers: sse,
    delayMs: 5,
    // Gemini sends a function call whole, with no id, and finishes with STOP.
    chunks: [gmChunk([{ functionCall: { name: 'get_time', args: { zone: 'UTC' } } }], 'STOP', { prompt: 48, out: 6 })]
  },
  'auth-error': { status: 400, headers: json, delayMs: 0, chunks: [JSON.stringify(geminiBadKey)] },
  slow: {
    status: 200,
    headers: sse,
    delayMs: 100,
    chunks: [...SLOW_PIECES.map((t) => gmChunk([{ text: t }])), gmChunk([{ text: '.' }], 'STOP', { prompt: 31, out: 40 })]
  }
};

// ---- Gemini through Google's OpenAI-compatible endpoint ----
// The same chunk shape as OpenAI's. Google's tool call ids differ and a bad key is a 400, sent as a one-item list.
// This shape is written from Google's docs and memory, not checked against the live endpoint.

const geminiOpenai: Record<Scenario, Recording> = {
  text: openai.text,
  'tool-call': {
    status: 200,
    headers: sse,
    delayMs: 5,
    chunks: [
      oaChunk({
        role: 'assistant',
        tool_calls: [{ index: 0, id: 'function-call-15409270000000000000', type: 'function', function: { name: 'get_time', arguments: '{"zone":"UTC"}' } }]
      }, 'tool_calls'),
      oaUsage(48, 6),
      'data: [DONE]\n\n'
    ]
  },
  'auth-error': { status: 400, headers: json, delayMs: 0, chunks: [JSON.stringify([geminiBadKey])] },
  slow: openai.slow
};

// Not a contract scenario: an Anthropic reply with a signed thinking block before a tool call, to see what the port keeps.
export const anthropicThinking: Recording = {
  status: 200,
  headers: { ...sse, 'request-id': 'req_rec_5' },
  delayMs: 5,
  chunks: [
    anStart(48, 1200),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'They want the time. ' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Use get_time.' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQBCgIYAhIM-recorded-signature' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_rec_2', name: 'get_time', input: {} }
    }),
    event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"zone": "UTC"}' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 1 }),
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 30 }
    }),
    event('message_stop', { type: 'message_stop' })
  ]
};

export const recordings: Record<Wire, Record<string, Recording>> = {
  openai,
  anthropic: { ...anthropic, thinking: anthropicThinking },
  gemini,
  'gemini-openai': geminiOpenai
};
