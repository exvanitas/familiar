/* Settings' Test button: one small call that says in plain words what's wrong. It never shows a key or
   an endpoint's own text: the adapter's errors are Familiar's words, and so is everything here. It
   asks the model to call a do-nothing tool, and says tools work only when a well-formed call to that
   tool comes back. A plain answer leaves tool use unproven. A second call, without the tool, is made
   only when the first was refused, to tell a model that can't call tools from one that isn't there. */
import type { ModelError, ModelEvent, ModelPort, ModelRequest } from '@familiar/core';
import type { ModelList } from './models.ts';
import type { Preset } from './presets.ts';

export type TestProblem =
  | 'no-key' | 'key-refused' | 'not-allowed' | 'unreachable' | 'model-not-found' | 'rate-limited' | 'endpoint-failed'
  | 'filtered' | 'refused' | 'stopped' | 'other';

export type TestResult =
  /** `ok`: the model answered. `tools` is 'yes' only for a valid call to the test tool. */
  | { readonly ok: true; readonly tools: 'yes' | 'no' | 'unproven'; readonly message: string }
  | { readonly ok: false; readonly problem: TestProblem; readonly message: string };

export interface TestInput {
  readonly preset: Preset;
  readonly model: string;
  readonly hasKey: boolean;
  /** The adapter for this endpoint. */
  readonly port: ModelPort;
  /** The endpoint's model list, asked for only to tell a missing model from another refusal. */
  readonly list?: () => Promise<ModelList>;
  readonly signal?: AbortSignal;
}

export const TEST_TOOL = { name: 'familiar_test', description: 'Does nothing. Present only to check tool calling.', inputSchema: { type: 'object', properties: {} } };

function request(model: string, tools: boolean): ModelRequest {
  return tools
    ? { model, system: `This is a connection test. Call the ${TEST_TOOL.name} tool once, with no arguments.`, messages: [{ role: 'user', content: `Call ${TEST_TOOL.name}.` }], tools: [TEST_TOOL], maxOutputTokens: 64 }
    : { model, system: 'Reply with the single word: ok.', messages: [{ role: 'user', content: 'Say ok.' }], tools: [], maxOutputTokens: 16 };
}

type End = Extract<ModelEvent, { type: 'done' | 'error' }>;
async function run(stream: AsyncIterable<ModelEvent>): Promise<{ end: End; calledTool: boolean }> {
  let end: ModelEvent | undefined;
  let calledTool = false;
  for await (const e of stream) {
    end = e;
    const args = e.type === 'tool-call' ? e.call.arguments : undefined;
    if (e.type === 'tool-call' && e.call.name === TEST_TOOL.name && !!args && typeof args === 'object' && !Array.isArray(args)) calledTool = true;
  }
  if (end?.type === 'done' || end?.type === 'error') return { end, calledTool };
  return { end: { type: 'error', error: { kind: 'unknown', message: 'The reply ended without finishing.' } }, calledTool };
}
const last = async (stream: AsyncIterable<ModelEvent>) => (await run(stream)).end;

export async function testEndpoint(t: TestInput): Promise<TestResult> {
  if (t.preset.key === 'required' && !t.hasKey) return { ok: false, problem: 'no-key', message: `No key is saved for ${t.preset.label}. Type one in, then test again.` };
  const { end: first, calledTool } = await run(t.port.stream(request(t.model, true), t.signal));
  if (first.type === 'done') {
    return calledTool
      ? { ok: true, tools: 'yes', message: `${t.preset.label} answered, and ${t.model} called the test tool, so it can call tools.` }
      : { ok: true, tools: 'unproven', message: `${t.model} answered without calling the tool, so tool use is unproven.` };
  }
  if (first.error.kind === 'invalid-tool-call') return { ok: true, tools: 'unproven', message: `${t.model} answered, but its call to the test tool was malformed, so tool use is unproven.` };
  // A refusal or a 404 can be about the tool: OpenRouter answers 404 when no provider of a model takes
  // tools. The same call without it tells which.
  if (first.error.kind === 'bad-request' || first.error.kind === 'not-found') {
    const plain = await last(t.port.stream(request(t.model, false), t.signal));
    if (plain.type === 'done') return { ok: true, tools: 'no', message: `${t.model} answered, but it can't call tools, so it chats with tools off.` };
    if (plain.error.kind === 'not-found' || (plain.error.kind === 'bad-request' && (await missing(t)))) return notFound(t);
  }
  return problem(t, first.error);
}

async function missing(t: TestInput): Promise<boolean> {
  const l = await t.list?.().catch(() => undefined);
  return !!l?.ok && !l.models.some(m => m.id === t.model);
}

const notFound = (t: TestInput): TestResult => ({ ok: false, problem: 'model-not-found', message: `${t.preset.label} has no model called ${t.model}. Pick one from its list.` });

function problem(t: TestInput, e: ModelError): TestResult {
  const name = t.preset.label;
  switch (e.kind) {
    case 'auth':
      return e.transport === 'no-key'
        ? { ok: false, problem: 'no-key', message: `No key is saved for ${name}. Type one in, then test again.` }
        : { ok: false, problem: 'key-refused', message: `${name} refused the key. Check it and type it in again.` };
    case 'network':
      if (e.transport === 'not-saved') return { ok: false, problem: 'not-allowed', message: `Familiar isn't allowed to reach ${name}'s address yet.` };
      return { ok: false, problem: 'unreachable', message: `Couldn't reach ${name}: ${e.message}${t.preset.key === 'none' ? ' Is it running?' : ''}` };
    case 'rate-limit':
      return { ok: false, problem: 'rate-limited', message: `${name} is limiting requests right now. The key works; try again shortly.` };
    case 'server':
      return { ok: false, problem: 'endpoint-failed', message: `${name} failed to answer. Try again later.` };
    case 'filtered':
      return { ok: false, problem: 'filtered', message: `${name} answered, but its content filter stopped the reply.` };
    case 'bad-request':
      return { ok: false, problem: 'refused', message: `${name} refused the test request. Check the model and the address.` };
    case 'aborted':
      return { ok: false, problem: 'stopped', message: 'The test was stopped.' };
    default:
      return { ok: false, problem: 'other', message: `The test failed: ${e.message}` };
  }
}
