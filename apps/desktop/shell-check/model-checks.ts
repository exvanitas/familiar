/* The model layer in the real webview: the model port contract over guardedFetch, against the recorded
   endpoints net-server.mjs serves at a saved address, for all three APIs, with a key typed into
   Settings. Run from core in the main phase, after the net checks. See "Model layer" in
   docs/model-design.md.

   - check.model.contract: every contract case passes for OpenAI chat completions, Anthropic Messages
     and Gemini's OpenAI-compatible route. Its control: a case run against the wrong recording fails,
     so a pass means the cases ran.
   - security.model.key-swap: the adapter's requests carried only the placeholder; the endpoint got the
     stored key (it answers with a hash of what it got); the endpoint's echo of the key came back as
     [key]; and nothing the page saw held the key. Its control: a second address with no stored key,
     to which the page sends a key it made itself. That one is neither swapped nor blanked: the
     endpoint's hash matches it and its echo comes back whole, so the hash and the scan both work. */
import { modelPortContract, CONTRACT_REQUEST, type ContractScenario, type ModelPortHarness } from '@familiar/core/testing';
import type { ModelEvent } from '@familiar/core';
import { guardedFetch, PLACEHOLDER } from '../src/net.ts';
import { createPiAiPort } from '../src/model/pi-ai.ts';
import { adapterOptions, type PresetId } from '../src/model/presets.ts';
import { check, fail, ok, rand, step } from './common.ts';
import { saved } from './net-checks.ts';
import { WIRES, type Wire } from './model-recordings.ts';

type Ctx = { ask: <T>(to: string, cmd: string, args?: unknown) => Promise<T> };
interface Typed { sha: string; head: string; tail: string; length: number }
interface Net { http: number }

const PRESET: Record<Wire, PresetId> = { openai: 'openai', anthropic: 'anthropic', gemini: 'gemini' };
const UA = 'Familiar/check';
/* Where each API carries the key. */
const KEY_HEADER: Record<Wire, string> = { openai: 'authorization', gemini: 'authorization', anthropic: 'x-api-key' };

async function sha256(text: string): Promise<string> {
  if (!crypto.subtle) fail('no WebCrypto in this page');
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}

async function drain(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/* Everything the page saw of each request and response, through a watching fetch. */
interface Exchange { sent: [string, string][]; status: number; headers: [string, string][]; body: string }
function watching(inner: typeof fetch, log: Exchange[]): typeof fetch {
  return async (input, init) => {
    const sent = [...new Headers(init?.headers).entries()];
    const r = await inner(input, init);
    log.push({ sent, status: r.status, headers: [...r.headers.entries()], body: await r.clone().text() });
    return r;
  };
}

export async function modelChecks(ctx: Ctx): Promise<void> {
  const net = (await (await fetch('net.json', { cache: 'no-store' })).json()) as Net;
  const base = `http://127.0.0.1:${net.http}`;
  const M = await saved({ kind: 'model', url: `${base}/model`, label: 'the recorded model endpoints' });
  await ctx.ask('settings', 'paste-ready');
  const typed = await step<Typed>('type-key', { title: 'Familiar check settings', long: true, ref: `addr:${M.id}` });
  const savedKey = await ctx.ask<string>('settings', 'save-key', `addr:${M.id}`);
  if (savedKey !== 'ok') fail('Settings could not save the key: ' + savedKey);
  const holds = (texts: string[], k: { head: string; tail: string }) => texts.some(t => t.includes(k.head) || t.includes(k.tail));

  const harness = (wire: Wire, fetchImpl: typeof fetch, only?: ContractScenario): ModelPortHarness => ({
    forScenario: s => createPiAiPort(adapterOptions({ preset: PRESET[wire], baseUrl: `${base}/model/${wire}/${only ?? s}`, hasKey: true, fetch: fetchImpl, userAgent: UA }))
  });

  await check('check.model.contract', async () => {
    const failed: string[] = [];
    let passed = 0;
    for (const wire of WIRES) {
      for (const c of modelPortContract) {
        try {
          await c.run(harness(wire, guardedFetch(M.id)));
          passed++;
        } catch (e) {
          failed.push(`${wire}: ${c.name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
        }
      }
    }
    // The control: the tool-call case against the text recording must fail.
    const toolCase = modelPortContract.find(c => c.name.startsWith('a tool call arrives'))!;
    const control = await toolCase.run(harness('openai', guardedFetch(M.id), 'text')).then(() => 'passed', () => 'failed');
    ok(failed.length === 0, `${failed.length} failed: ${failed.join(' | ')}`);
    ok(control === 'failed', 'the control, a tool-call case against a text reply, passed');
    return `${passed} of ${WIRES.length * modelPortContract.length} contract cases passed over guardedFetch, ${modelPortContract.length} for each of ${WIRES.join(', ')}; the control (a case against the wrong recording) failed`;
  });

  await check('security.model.key-swap', async () => {
    const lines: string[] = [];
    for (const wire of WIRES) {
      const log: Exchange[] = [];
      const f = watching(guardedFetch(M.id), log);
      const text = await drain(harness(wire, f).forScenario('text').stream(CONTRACT_REQUEST));
      const refused = await drain(harness(wire, f).forScenario('auth-error').stream(CONTRACT_REQUEST));
      const keyHeader = KEY_HEADER[wire];
      const seen = log.flatMap(x => [...x.sent.flat(), ...x.headers.flat(), x.body]);
      ok(log.length === 2, `${wire}: ${log.length} requests`);
      ok(log.every(x => x.sent.filter(([, v]) => v.includes(PLACEHOLDER)).map(([k]) => k).join() === keyHeader), `${wire}: the placeholder wasn't in exactly ${keyHeader}`);
      ok(log.every(x => x.headers.find(([k]) => k === 'x-auth-sha256')?.[1] === typed.sha), `${wire}: the endpoint didn't get the stored key`);
      ok(log[1]!.body.includes('[key]'), `${wire}: the endpoint's echo of the key didn't come back as [key]`);
      ok(!holds([...seen, JSON.stringify(text), JSON.stringify(refused)], typed), `${wire}: something the page saw held the key`);
      ok(text.at(-1)?.type === 'done' && refused.at(-1)?.type === 'error', `${wire}: ${JSON.stringify(text.at(-1))} / ${JSON.stringify(refused.at(-1))}`);
      lines.push(wire);
    }
    // The control: a key the page made, sent to an address with no stored key. Not a stored secret, so
    // nothing swaps or blanks it, and both the hash and the scan must see it.
    const M0 = await saved({ kind: 'model', url: `${base}/model0`, label: 'the control, with no stored key' });
    const control = 'ck' + rand(30);
    const log: Exchange[] = [];
    const port = createPiAiPort({ ...adapterOptions({ preset: 'custom', baseUrl: `${base}/model0/openai/auth-error`, hasKey: false, fetch: watching(guardedFetch(M0.id), log), userAgent: UA }), apiKey: control });
    await drain(port.stream(CONTRACT_REQUEST));
    const want = await sha256(`Bearer ${control}`);
    ok(log[0]?.headers.find(([k]) => k === 'x-auth-sha256')?.[1] === want, "the control: the endpoint's hash didn't match the key sent");
    ok(holds([log[0]!.body], { head: control.slice(0, 10), tail: control.slice(-10) }) && !log[0]!.body.includes('[key]'), "the control: the endpoint's echo didn't come back whole");
    return `for ${lines.join(', ')}: the page sent only the placeholder, the endpoint got the key typed into Settings, its echo came back as [key], and no request, response or event the page saw held the key; the control's own key came back whole and hashed to match`;
  });
}
