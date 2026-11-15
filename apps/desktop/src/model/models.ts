/* An endpoint's model list, over the same guarded fetch as its calls. Price and tool calling are shown
   where the endpoint says so: OpenRouter publishes both. Elsewhere they're unknown, never guessed. A
   model without tool calling still chats, with tools off, and the list says why. */
import type { Price } from '@familiar/core';
import { PLACEHOLDER } from '../net.ts';
import type { EndpointSetup, Preset } from './presets.ts';
import { preset as presetOf, priceFor } from './presets.ts';

export interface ListedModel {
  readonly id: string;
  readonly name: string;
  readonly price?: Price;
  readonly tools: 'yes' | 'no' | 'unknown';
  /** Why tools are off, when they are. */
  readonly note?: string;
  readonly contextLength?: number;
}

export type ListProblem = 'no-key' | 'key-refused' | 'unreachable' | 'not-allowed' | 'not-found' | 'rate-limited' | 'endpoint-failed' | 'unreadable';
export type ModelList = { readonly ok: true; readonly models: readonly ListedModel[] } | { readonly ok: false; readonly problem: ListProblem; readonly message: string };

export const NO_TOOLS_NOTE = "This model can't call tools, so it chats with tools off.";
const ANTHROPIC_VERSION = '2023-06-01';

/* The headers a keyed request needs, with the placeholder the exe swaps for the stored key. */
export function authHeaders(p: Preset, hasKey: boolean): Record<string, string> {
  if (p.key === 'none' || !hasKey) return {};
  if (p.api === 'anthropic-messages') return { 'x-api-key': PLACEHOLDER, 'anthropic-version': ANTHROPIC_VERSION };
  return { authorization: `Bearer ${PLACEHOLDER}` };
}

export async function listModels(s: EndpointSetup, signal?: AbortSignal): Promise<ModelList> {
  const p = presetOf(s.preset);
  if (p.key === 'required' && !s.hasKey) return { ok: false, problem: 'no-key', message: 'No key is saved for this endpoint.' };
  const url = s.baseUrl.replace(/\/+$/, '') + p.modelsPath + (p.api === 'anthropic-messages' ? '?limit=1000' : '');
  let r: Response;
  try {
    r = await s.fetch(url, { headers: { accept: 'application/json', ...authHeaders(p, s.hasKey) }, ...(signal ? { signal } : {}) });
  } catch (e) {
    const kind = e instanceof Error ? (e.cause as { kind?: unknown } | undefined)?.kind : undefined;
    if (kind === 'no-key') return { ok: false, problem: 'no-key', message: 'No key is saved for this endpoint.' };
    if (kind === 'not-saved') return { ok: false, problem: 'not-allowed', message: "Familiar isn't allowed to reach this address yet." };
    return { ok: false, problem: 'unreachable', message: 'Could not reach the endpoint.' };
  }
  if (!r.ok) {
    void r.body?.cancel().catch(() => {});
    const s = r.status;
    if (s === 401 || s === 403) return { ok: false, problem: 'key-refused', message: `The endpoint refused the key (HTTP ${s}).` };
    if (s === 404) return { ok: false, problem: 'not-found', message: 'The endpoint has no model list at this address (HTTP 404).' };
    if (s === 429) return { ok: false, problem: 'rate-limited', message: 'The endpoint is limiting requests. Try again shortly.' };
    if (s >= 500) return { ok: false, problem: 'endpoint-failed', message: `The endpoint failed to answer (HTTP ${s}).` };
    return { ok: false, problem: 'unreadable', message: `The endpoint refused the request (HTTP ${s}).` };
  }
  const json = await r.json().catch(() => undefined);
  const data = (json as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) return { ok: false, problem: 'unreadable', message: "The endpoint's model list wasn't in a form Familiar knows." };
  const models = data.flatMap(m => toListed(p, m));
  return { ok: true, models: models.sort((a, b) => a.name.localeCompare(b.name)) };
}

interface Raw {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  context_length?: unknown;
  supported_parameters?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown; input_cache_write?: unknown };
}

function toListed(p: Preset, raw: unknown): ListedModel[] {
  const m = raw as Raw;
  if (typeof m?.id !== 'string' || !m.id) return [];
  // Google's list names its models `models/<id>`; the chat endpoint takes the bare id.
  const id = p.id === 'gemini' ? m.id.replace(/^models\//, '') : m.id;
  const name = typeof m.name === 'string' ? m.name : typeof m.display_name === 'string' ? m.display_name : id;
  const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : undefined;
  const tools = params ? (params.includes('tools') ? 'yes' : 'no') : 'unknown';
  const price = priceFor(p, openRouterPrice(m.pricing));
  return [{
    id,
    name,
    tools,
    ...(tools === 'no' ? { note: NO_TOOLS_NOTE } : {}),
    ...(price ? { price } : {}),
    ...(typeof m.context_length === 'number' ? { contextLength: m.context_length } : {})
  }];
}

/* OpenRouter prices are US dollars per token, as strings. A negative one means it varies (its auto
   router), which is unknown. */
function openRouterPrice(p: Raw['pricing']): Price | undefined {
  if (!p) return undefined;
  const per = (v: unknown) => {
    const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined;
  };
  const input = per(p.prompt), output = per(p.completion);
  if (input === undefined || output === undefined) return undefined;
  const read = per(p.input_cache_read), write = per(p.input_cache_write);
  return { inputPerMTok: input, outputPerMTok: output, ...(read !== undefined ? { cacheReadPerMTok: read } : {}), ...(write !== undefined ? { cacheWritePerMTok: write } : {}) };
}
