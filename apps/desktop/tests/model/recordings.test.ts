/* The recorded endpoints' replay check reads each API's structure, so a pass in the contract means the
   signature came back where that API reads it. These are its controls: the signature in plain text, on
   the wrong call, or after the call, must all be refused. The first body of each wire is what the real
   adapter sent, captured from a run, so the check is known to pass on the real thing. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT_REQUEST, followUp } from '@familiar/core/testing';
import type { ModelEvent } from '@familiar/core';
import { carriesReplay, REPLAY_CALL_IDS, SIGNATURES, type Wire } from '../../shell-check/model-recordings.ts';
import { createPiAiPort } from '../../src/model/pi-ai.ts';
import { adapterOptions } from '../../src/model/presets.ts';
import { startModelServer, type ModelServer } from './server.ts';

let server: ModelServer;
beforeAll(async () => { server = await startModelServer(); });
afterAll(() => server.close());

const PRESET = { openai: 'openrouter', anthropic: 'anthropic', gemini: 'gemini' } as const;

async function realFollowUp(wire: Wire): Promise<string> {
  const port = (s: string) => createPiAiPort(adapterOptions({ preset: PRESET[wire], baseUrl: `${server.url}/${wire}/${s}`, hasKey: true, fetch: (i, n) => fetch(i, n), userAgent: 'x' }));
  const events: ModelEvent[] = [];
  for await (const e of port('thinking-tool-call').stream(CONTRACT_REQUEST)) events.push(e);
  const done = events.at(-1)!;
  if (done.type !== 'done') throw new Error('no done');
  const calls = events.flatMap(e => (e.type === 'tool-call' ? [e.call] : []));
  const before = server.seen.length;
  for await (const _ of port('replay-check').stream(followUp({ role: 'assistant', content: '', toolCalls: calls, replay: done.replay! }))) void _;
  return server.seen[before]!.body;
}

const sig = SIGNATURES;
const user = { role: 'user', content: 'Say hello, or tell me the time.' };

describe('the replay check', () => {
  for (const wire of ['openai', 'anthropic', 'gemini'] as const) {
    it(`${wire}: passes on what the adapter really sends`, async () => {
      expect(carriesReplay(wire, await realFollowUp(wire))).toBe(true);
    });
  }

  it('Anthropic: refuses the signature as text, a thinking block after the call, or one with another signature', () => {
    const tool = { type: 'tool_use', id: REPLAY_CALL_IDS.anthropic, name: 'get_time', input: { zone: 'UTC' } };
    const thinking = { type: 'thinking', thinking: 'They want the time.', signature: sig.anthropic };
    const body = (content: unknown[]) => JSON.stringify({ messages: [user, { role: 'assistant', content }] });
    expect(carriesReplay('anthropic', body([thinking, tool]))).toBe(true);
    expect(carriesReplay('anthropic', body([{ type: 'text', text: `signature ${sig.anthropic}` }, tool]))).toBe(false);
    expect(carriesReplay('anthropic', body([tool, thinking]))).toBe(false);
    expect(carriesReplay('anthropic', body([{ ...thinking, signature: 'other' }, tool]))).toBe(false);
    expect(carriesReplay('anthropic', body([thinking, { ...tool, id: 'toolu_other' }]))).toBe(false);
  });

  it("OpenRouter's wire: refuses the signature as text, or anywhere but reasoning_details", () => {
    const call = { id: REPLAY_CALL_IDS.openai, type: 'function', function: { name: 'get_time', arguments: '{"zone":"UTC"}' } };
    const body = (m: object) => JSON.stringify({ messages: [user, { role: 'assistant', tool_calls: [call], ...m }] });
    expect(carriesReplay('openai', body({ reasoning_details: [{ type: 'reasoning.text', text: 'x', signature: sig.openai }] }))).toBe(true);
    expect(carriesReplay('openai', body({ content: sig.openai }))).toBe(false);
    expect(carriesReplay('openai', body({ reasoning: sig.openai }))).toBe(false);
    expect(carriesReplay('openai', body({ reasoning_details: [{ type: 'reasoning.text', text: sig.openai }] }))).toBe(false);
  });

  it('Gemini: refuses the signature as text, on the wrong call, or on two calls', () => {
    const call = (id: string, signed: boolean) => ({ id, type: 'function', function: { name: 'get_time', arguments: '{}' }, ...(signed ? { extra_content: { google: { thought_signature: sig.gemini } } } : {}) });
    const body = (calls: unknown[], extra: object = {}) => JSON.stringify({ messages: [user, { role: 'assistant', tool_calls: calls, ...extra }] });
    expect(carriesReplay('gemini', body([call(REPLAY_CALL_IDS.gemini, true)]))).toBe(true);
    expect(carriesReplay('gemini', body([call(REPLAY_CALL_IDS.gemini, false)], { content: sig.gemini }))).toBe(false);
    expect(carriesReplay('gemini', body([call(REPLAY_CALL_IDS.gemini, false), call('function-call-other', true)]))).toBe(false);
    expect(carriesReplay('gemini', body([call(REPLAY_CALL_IDS.gemini, true), call('function-call-other', true)]))).toBe(false);
  });
});
