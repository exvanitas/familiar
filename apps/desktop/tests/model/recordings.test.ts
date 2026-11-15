/* The recorded endpoints' replay check reads each API's structure and the recorded content, so a pass
   in the contract means what was signed came back, where that API reads it. These are its controls:
   the signature in plain text, under altered thinking, on the wrong call or message, or after the call,
   must all be refused. The first body of each wire is what the real adapter sent, so the check is
   known to pass on the real thing. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT_REQUEST, CONTRACT_THINKING, followUp } from '@familiar/core/testing';
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
const ARGS = '{"zone":"UTC"}';
const ALTERED = 'They want the weather. Use get_time.';

describe('the replay check', () => {
  for (const wire of ['openai', 'anthropic', 'gemini'] as const) {
    it(`${wire}: passes on what the adapter really sends`, async () => {
      expect(carriesReplay(wire, await realFollowUp(wire))).toBe(true);
    });
  }

  it('Anthropic: refuses the signature as text, altered thinking under the signature, thinking after the call, or the wrong call', () => {
    const tool = { type: 'tool_use', id: REPLAY_CALL_IDS.anthropic, name: 'get_time', input: { zone: 'UTC' } };
    const thinking = { type: 'thinking', thinking: CONTRACT_THINKING, signature: sig.anthropic };
    const body = (content: unknown[]) => JSON.stringify({ messages: [user, { role: 'assistant', content }] });
    expect(carriesReplay('anthropic', body([thinking, tool]))).toBe(true);
    expect(carriesReplay('anthropic', body([{ type: 'text', text: `signature ${sig.anthropic}` }, tool]))).toBe(false);
    expect(carriesReplay('anthropic', body([{ ...thinking, thinking: ALTERED }, tool]))).toBe(false);
    expect(carriesReplay('anthropic', body([tool, thinking]))).toBe(false);
    expect(carriesReplay('anthropic', body([{ ...thinking, signature: 'other' }, tool]))).toBe(false);
    expect(carriesReplay('anthropic', body([thinking, { ...tool, id: 'toolu_other' }]))).toBe(false);
    expect(carriesReplay('anthropic', body([thinking, { ...tool, input: { zone: 'PST' } }]))).toBe(false);
  });

  it("OpenRouter's wire: refuses the signature as text, altered reasoning under the signature, or details on a message without the call", () => {
    const call = { id: REPLAY_CALL_IDS.openai, type: 'function', function: { name: 'get_time', arguments: ARGS } };
    const details = [{ type: 'reasoning.text', text: CONTRACT_THINKING, signature: sig.openai }];
    const body = (m: object, calls: unknown[] = [call]) => JSON.stringify({ messages: [user, { role: 'assistant', tool_calls: calls, ...m }] });
    expect(carriesReplay('openai', body({ reasoning_details: details }))).toBe(true);
    expect(carriesReplay('openai', body({ content: sig.openai }))).toBe(false);
    expect(carriesReplay('openai', body({ reasoning: sig.openai }))).toBe(false);
    expect(carriesReplay('openai', body({ reasoning_details: [{ type: 'reasoning.text', text: sig.openai }] }))).toBe(false);
    expect(carriesReplay('openai', body({ reasoning_details: [{ ...details[0], text: ALTERED }] }))).toBe(false);
    // The details on an assistant message without the call, next to one that holds it.
    const split = JSON.stringify({ messages: [user, { role: 'assistant', content: 'thinking aloud', reasoning_details: details }, { role: 'assistant', tool_calls: [call] }] });
    expect(carriesReplay('openai', split)).toBe(false);
    expect(carriesReplay('openai', body({ reasoning_details: details }, [{ ...call, id: 'call_other' }]))).toBe(false);
  });

  it('Gemini: refuses the signature as text, on the wrong call, on two calls, or on the call with altered arguments', () => {
    const call = (id: string, signed: boolean, args = ARGS) => ({ id, type: 'function', function: { name: 'get_time', arguments: args }, ...(signed ? { extra_content: { google: { thought_signature: sig.gemini } } } : {}) });
    const body = (calls: unknown[], extra: object = {}) => JSON.stringify({ messages: [user, { role: 'assistant', tool_calls: calls, ...extra }] });
    expect(carriesReplay('gemini', body([call(REPLAY_CALL_IDS.gemini, true)]))).toBe(true);
    expect(carriesReplay('gemini', body([call(REPLAY_CALL_IDS.gemini, false)], { content: sig.gemini }))).toBe(false);
    expect(carriesReplay('gemini', body([call(REPLAY_CALL_IDS.gemini, false), call('function-call-other', true)]))).toBe(false);
    expect(carriesReplay('gemini', body([call(REPLAY_CALL_IDS.gemini, true), call('function-call-other', true)]))).toBe(false);
    expect(carriesReplay('gemini', body([call(REPLAY_CALL_IDS.gemini, true, '{"zone":"PST"}')]))).toBe(false);
  });
});
