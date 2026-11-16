/* The trait reader's call over the real pi-ai adapter, against recorded set_traits replies in all
   three wire formats, then through readTraits and its check. As the reader does in the app: one
   call, set_traits the only tool, the persona's own endpoint. */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCard, type Card } from '@familiar/cards';
import { readTraits } from '@familiar/core';
import { createPiAiPort } from '../../src/model/pi-ai.ts';
import { adapterOptions } from '../../src/model/presets.ts';
import type { Wire } from '../../shell-check/model-recordings.ts';
import { startModelServer, type ModelServer } from './server.ts';
import { TRAIT_READING, traitAnswer } from './trait-recordings.ts';

let server: ModelServer;
beforeAll(async () => { server = await startModelServer(undefined, traitAnswer); });
afterAll(() => server.close());

const PRESET = { openai: 'openrouter', anthropic: 'anthropic', gemini: 'gemini' } as const;
const digest = async (b: Uint8Array) => new Uint8Array(await webcrypto.subtle.digest('SHA-256', b));

function pell(): Card {
  const r = readCard(new Uint8Array(readFileSync(new URL('../../../../packages/cards/fixtures/cards/v2-pell.json', import.meta.url))));
  if (!r.ok) throw new Error(r.error.kind);
  return r.card;
}

describe('the trait reader over recorded replies', () => {
  for (const wire of ['openai', 'anthropic', 'gemini'] as const satisfies readonly Wire[]) {
    it(`${wire}: the set_traits call comes back as the checked reading`, async () => {
      const port = createPiAiPort(adapterOptions({ preset: PRESET[wire], baseUrl: `${server.url}/${wire}/set-traits`, hasKey: true, fetch: (i, n) => fetch(i, n), userAgent: 'Familiar/test' }));
      const before = server.seen.length;
      const r = await readTraits(pell(), port, { model: 'contract-model', userName: 'Sam', digest });
      expect(r).toMatchObject({ ok: true, fromCache: false });
      expect(r.ok && r.reading).toEqual(TRAIT_READING);
      // One request, offering set_traits alone, holding the card's description and none of what's kept back.
      const sent = server.seen.slice(before);
      expect(sent).toHaveLength(1);
      const body = JSON.parse(sent[0]!.body) as { tools: { name?: string; function?: { name: string } }[] };
      expect(body.tools.map((t) => t.name ?? t.function?.name)).toEqual(['set_traits']);
      expect(sent[0]!.body).toContain('garden sprite');
      for (const kept of ['Invented for Familiar', 'playful tone', 'Stay in character', 'fantasy']) expect(sent[0]!.body).not.toContain(kept);
    });
  }
});
