// A Card out as canonical V3 JSON: the fields in one fixed order and `extensions` with sorted keys, so
// the same card always gives the same text. That text is also what the trait reader's cache key hashes.
import type { Card, JsonValue, LoreEntry, Lorebook } from './types.ts';

export function toV3Json(card: Card): string {
  return JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: cardData(card) });
}

function cardData(c: Card): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: c.name,
    description: c.description,
    personality: c.personality,
    scenario: c.scenario,
    first_mes: c.first_mes,
    mes_example: c.mes_example,
    alternate_greetings: [...c.alternate_greetings],
    group_only_greetings: [...c.group_only_greetings],
    system_prompt: c.system_prompt,
    post_history_instructions: c.post_history_instructions,
    creator_notes: c.creator_notes,
    creator: c.creator,
    character_version: c.character_version,
    tags: [...c.tags],
    extensions: sorted(c.extensions)
  };
  if (c.nickname !== undefined) out.nickname = c.nickname;
  if (c.creator_notes_multilingual !== undefined) out.creator_notes_multilingual = sorted(c.creator_notes_multilingual);
  if (c.source !== undefined) out.source = [...c.source];
  if (c.creation_date !== undefined) out.creation_date = c.creation_date;
  if (c.modification_date !== undefined) out.modification_date = c.modification_date;
  if (c.assets !== undefined) out.assets = c.assets.map((a) => ({ type: a.type, uri: a.uri, name: a.name, ext: a.ext }));
  if (c.character_book !== undefined) out.character_book = book(c.character_book);
  return out;
}

function book(b: Lorebook): Record<string, unknown> {
  const out: Record<string, unknown> = { name: b.name, description: b.description };
  if (b.scan_depth !== undefined) out.scan_depth = b.scan_depth;
  if (b.token_budget !== undefined) out.token_budget = b.token_budget;
  out.recursive_scanning = b.recursive_scanning;
  out.extensions = sorted(b.extensions);
  out.entries = b.entries.map(entry);
  return out;
}

function entry(e: LoreEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    keys: [...e.keys],
    secondary_keys: [...e.secondary_keys],
    content: e.content,
    enabled: e.enabled,
    insertion_order: e.insertion_order,
    priority: e.priority,
    case_sensitive: e.case_sensitive,
    selective: e.selective,
    constant: e.constant,
    use_regex: e.use_regex,
    position: e.position,
    name: e.name,
    comment: e.comment,
    extensions: sorted(e.extensions)
  };
  if (e.id !== undefined) out.id = e.id;
  return out;
}

/** A JSON value with every object's keys sorted. Built with defineProperty, so no key is special. */
function sorted(v: JsonValue | { readonly [k: string]: JsonValue }): JsonValue {
  if (Array.isArray(v)) return v.map(sorted);
  if (v === null || typeof v !== 'object') return v;
  const out: { [k: string]: JsonValue } = {};
  for (const k of Object.keys(v).sort()) {
    Object.defineProperty(out, k, { value: sorted((v as { [k: string]: JsonValue })[k]!), enumerable: true, writable: true, configurable: true });
  }
  return out;
}
