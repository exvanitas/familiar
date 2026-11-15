/* The endpoints Familiar knows, as plain data, and the one function that turns a preset into adapter
   options. Each preset sets its own compatibility options, so nothing depends on pi-ai guessing from
   the address (spikes.md). The table is in docs/model-design.md. */
import type { AnthropicMessagesCompat, OpenAICompletionsCompat } from '@earendil-works/pi-ai';
import type { Price } from '@familiar/core';
import { PLACEHOLDER } from '../net.ts';
import type { AdapterOptions, WireApi } from './pi-ai.ts';
import { CATALOG_PRICES } from './catalog-prices.ts';

export type PresetId = 'openrouter' | 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'lmstudio' | 'custom';

export interface Preset {
  readonly id: PresetId;
  readonly label: string;
  readonly api: WireApi;
  /** The base URL. Custom has none: the person types it. */
  readonly baseUrl?: string;
  /** 'required': it can't work without one. 'optional': sent only when one is saved. 'none': local. */
  readonly key: 'required' | 'optional' | 'none';
  /** pi-ai's provider name. */
  readonly provider: string;
  readonly compat?: OpenAICompletionsCompat | AnthropicMessagesCompat;
  /** Prompt caching, where the endpoint has it. */
  readonly cache?: 'none' | 'short';
  /** A local model costs nothing to call, so its price is known: $0. */
  readonly free?: true;
  /** Where its model list is, under the base URL. */
  readonly modelsPath: string;
}

/* For servers that may refuse what OpenAI added later: no `store` field, no `developer` role, and
   the older `max_tokens`. */
const PLAIN: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: 'max_tokens',
  supportsStrictMode: false
};

export const PRESETS: readonly Preset[] = [
  {
    id: 'openrouter', label: 'OpenRouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', key: 'required', provider: 'openrouter',
    // OpenRouter streams reasoning with its signatures as `reasoning_details`, which pi-ai carries back.
    compat: { supportsStore: false, thinkingFormat: 'openrouter', maxTokensField: 'max_tokens' },
    modelsPath: '/models'
  },
  {
    id: 'openai', label: 'OpenAI', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1', key: 'required', provider: 'openai',
    // pi-ai sends `store: false`, so OpenAI keeps no copy of the conversation for its dashboard.
    compat: { supportsStore: true, supportsDeveloperRole: true, maxTokensField: 'max_completion_tokens' },
    modelsPath: '/models'
  },
  {
    id: 'anthropic', label: 'Anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', key: 'required', provider: 'anthropic',
    // pi-ai marks the system prompt, the tools and the last message for caching. Reads cost a tenth of
    // input, writes a quarter more, and a chat rereads the same prompt every turn.
    cache: 'short',
    modelsPath: '/v1/models'
  },
  {
    // Google's OpenAI-compatible endpoint: pi-ai's native Gemini path can't take an injected fetch.
    id: 'gemini', label: 'Google Gemini', api: 'openai-completions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'required', provider: 'google',
    compat: { ...PLAIN, supportsReasoningEffort: true },
    modelsPath: '/models'
  },
  {
    id: 'ollama', label: 'Ollama', api: 'openai-completions', baseUrl: 'http://localhost:11434/v1', key: 'none', provider: 'ollama',
    compat: PLAIN, free: true, modelsPath: '/models'
  },
  {
    id: 'lmstudio', label: 'LM Studio', api: 'openai-completions', baseUrl: 'http://localhost:1234/v1', key: 'none', provider: 'lmstudio',
    compat: PLAIN, free: true, modelsPath: '/models'
  },
  {
    id: 'custom', label: 'Another OpenAI-compatible endpoint', api: 'openai-completions', key: 'optional', provider: 'custom',
    compat: PLAIN, modelsPath: '/models'
  }
];

export function preset(id: PresetId): Preset {
  const p = PRESETS.find(x => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return p;
}

/* What a keyless endpoint gets as its key: the SDKs need one, and it must not be the placeholder, which
   the exe would refuse without a stored key. */
export const NO_KEY = 'none';

export interface EndpointSetup {
  readonly preset: PresetId;
  /** The saved base URL: the preset's own, or the one typed for Custom or a moved local server. */
  readonly baseUrl: string;
  /** Whether a key is saved for the address. */
  readonly hasKey: boolean;
  /** The fetch for the saved address: `guardedFetch(address.id)` in the app. */
  readonly fetch: typeof globalThis.fetch;
  readonly userAgent: string;
}

export function adapterOptions(s: EndpointSetup): AdapterOptions {
  const p = preset(s.preset);
  const sendsKey = p.key === 'required' || (p.key === 'optional' && s.hasKey);
  return {
    api: p.api,
    baseUrl: s.baseUrl.replace(/\/+$/, ''),
    apiKey: sendsKey ? PLACEHOLDER : NO_KEY,
    fetch: s.fetch,
    provider: p.provider,
    userAgent: s.userAgent,
    ...(p.compat ? { compat: p.compat } : {}),
    ...(p.cache ? { cacheRetention: p.cache } : {})
  };
}

/** How a price from the catalog is labelled wherever it's shown, so it's never taken for a live one. */
export const CATALOG_LABEL = "listed price in Familiar's model catalog";

/**
 * The price to use for a model, best first: one the person typed; a local server's $0; the endpoint's
 * own list (OpenRouter); for OpenAI, Anthropic and Gemini, which publish none, the listed price in
 * Familiar's model catalog for a model id it knows. Otherwise unknown, and a dollar cap pauses.
 */
export function priceFor(p: Preset, listed: Price | undefined, modelId?: string, typed?: Price): Price | undefined {
  if (typed) return { ...typed, source: 'typed' };
  if (p.free) return { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, source: 'local' };
  if (listed) return { ...listed, source: 'endpoint' };
  const book = p.id === 'openai' || p.id === 'anthropic' || p.id === 'gemini' ? CATALOG_PRICES[p.id] : undefined;
  const found = modelId !== undefined && book && Object.hasOwn(book, modelId) ? book[modelId] : undefined;
  return found ? { ...found, source: 'catalog' } : undefined;
}
