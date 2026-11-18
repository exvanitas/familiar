/* Build-start check B3 (the MCP rebuild, her line in 2.1): what reaches each preset's wire when her
   remark sits in the conversation as a model-visible entry. Two shapes: an assistant message right
   after her last reply (two assistant messages in a row), or a user-role note (two user messages in a
   row, once you write). No network and no key: the fetch is a stub that records the body and refuses. */
import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '@familiar/core';
import { createPiAiPort } from '../../src/model/pi-ai.ts';
import { adapterOptions, PRESETS, type PresetId } from '../../src/model/presets.ts';

const base: ModelRequest['messages'] = [
  { role: 'user', content: 'Can you look at my plan?' },
  { role: 'assistant', content: 'It looks good.' }
];
const shapes: Record<string, ModelRequest['messages']> = {
  'assistant remark': [...base, { role: 'assistant', content: 'Oh, the kettle reminder is due.' }, { role: 'user', content: 'Thanks!' }],
  'user-role note': [...base, { role: 'user', content: '[She said, unprompted: "Oh, the kettle reminder is due."]' }, { role: 'user', content: 'Thanks!' }]
};

async function wireMessages(preset: PresetId, messages: ModelRequest['messages']) {
  let body: any;
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response('{"error":{"message":"stub"}}', { status: 400, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const p = PRESETS.find(x => x.id === preset)!;
  const port = createPiAiPort(adapterOptions({ preset, baseUrl: p.baseUrl ?? 'http://127.0.0.1:1/v1', hasKey: true, fetch, userAgent: 'Familiar/test' }));
  for await (const _ of port.stream({ model: 'm', system: 'You are her.', messages, tools: [] })) void _;
  return (body.messages as any[]).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : (m.content ?? []).map((c: any) => c.text ?? c.type).join(' | ') }));
}

describe('B3: her remark on the wire', () => {
  for (const preset of PRESETS.map(p => p.id)) {
    for (const [shape, messages] of Object.entries(shapes)) {
      it(`${preset}, ${shape}`, async () => {
        const wire = await wireMessages(preset, messages);
        console.log(`B3 ${preset} / ${shape}: ${JSON.stringify(wire)}`);
        expect(wire.length).toBeGreaterThan(0);
      });
    }
  }
});
