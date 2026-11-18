/* Her remark on each preset's wire (the MCP rebuild, 2.1 and build-start check B3). pi-ai passes
   messages through as they are, so two of one role in a row reach the endpoint unmerged; some chat
   templates refuse that. The decision: her remark is a user-role note, and core's request builder
   merges same-role messages (`alternate`), so every preset sees alternating roles. No network and no
   key: the fetch is a stub that records the body and refuses. */
import { describe, expect, it } from 'vitest';
import { alternate, type ModelRequest } from '@familiar/core';
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

const alternates = (wire: { role: string }[]) => wire.filter(m => m.role !== 'system').every((m, i, all) => i === 0 || m.role !== all[i - 1]!.role);

describe('B3: her remark on the wire', () => {
  for (const preset of PRESETS.map(p => p.id)) {
    it(`${preset}: unmerged, either shape repeats a role; through alternate(), the note shape alternates`, async () => {
      for (const messages of Object.values(shapes)) expect(alternates(await wireMessages(preset, messages))).toBe(false);
      const wire = await wireMessages(preset, alternate(shapes['user-role note']!));
      expect(alternates(wire)).toBe(true);
      expect(wire.at(-1)!.content).toMatch(/kettle reminder is due.*\n\nThanks!$/s);
    });
  }
});
