// The reader's answer check, the rules reader over every style, which reading wins, the chattiness
// suggestion, the cache key and the plain helper.
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyReading, cardHashOf, chattinessOf, checkAnswer, readerPrompt, effectiveTraits, NEUTRAL_STATE, plainHelper, plistWords, readByRules, readCard, setChattiness,
  setYours, shownTraits, suggestChattiness, toV3Json, traitCacheKey, useCards, wppWords, DEFAULT_HELPER_NAME, READER_VERSION, type TraitReading
} from '../src/index.ts';
import { card, fixtureBytes, makeCard } from './helpers.ts';

const QUOTABLE = ['She talks to customers only when she has to.', 'She is up   before the bakery opens.'];
const good = {
  sociability: 'reserved', closeness: 'aloof', lively: 'morning', interests: ['clocks', 'Fresh Bread ', 'rainy-day jazz'],
  evidence: { sociability: 'She talks to customers only when she has to.', lively: 'She is up before the bakery opens.', closeness: 'not in the card' }
};

describe('the answer check', () => {
  it('a valid answer gives its traits, interests cleaned, and only quotes found in the sent text', () => {
    expect(checkAnswer(good, QUOTABLE)).toEqual({
      sociability: 'reserved', closeness: 'aloof', lively: 'morning', interests: ['clocks', 'fresh bread', 'rainy-day jazz'],
      evidence: { sociability: 'She talks to customers only when she has to.', lively: 'She is up before the bakery opens.' }
    });
  });

  it('unsure, an unknown value, a wrong type or a missing trait: that trait neutral, the others kept', () => {
    const r = checkAnswer({ ...good, sociability: 'unsure', closeness: 'friendly', lively: 3 }, QUOTABLE)!;
    expect([r.sociability, r.closeness, r.lively]).toEqual(['even', 'warm', 'any']);
    const missing = checkAnswer({ closeness: 'clingy', interests: [], evidence: {} }, QUOTABLE)!;
    expect([missing.sociability, missing.closeness, missing.lively]).toEqual(['even', 'clingy', 'any']);
  });

  it('a field the schema has not: all three neutral and no interests', () => {
    const r = checkAnswer({ ...good, admin: true }, QUOTABLE)!;
    expect(r).toEqual({ sociability: 'even', closeness: 'warm', lively: 'any', interests: [], evidence: {} });
  });

  it('anything but a plain object is a failed reading', () => {
    for (const raw of [null, undefined, 'reserved', 42, [good], true]) expect(checkAnswer(raw, QUOTABLE)).toBeUndefined();
  });

  it('interests: at most 5, at most 32 characters, letters, digits, spaces and hyphens, no repeats', () => {
    const r = checkAnswer({
      ...good,
      interests: ['a', 'A ', 'x'.repeat(33), '<script>', 'b', 7, 'c  d', 'e', '-dash', 'f', 'g', 'café', '日本']
    }, QUOTABLE)!;
    expect(r.interests).toEqual(['a', 'b', 'c d', 'e', 'f']);
    expect(checkAnswer({ ...good, interests: ['café', '日本'] }, QUOTABLE)!.interests).toEqual(['café', '日本']);
    expect(checkAnswer({ ...good, interests: 'clocks' }, QUOTABLE)!.interests).toEqual([]);
  });

  it('quotes: over 120 characters, not a string, or for a neutral trait are dropped; whitespace is collapsed', () => {
    const long = 'x'.repeat(121);
    const r = checkAnswer({ ...good, sociability: 'even', evidence: { sociability: 'She talks', closeness: long, lively: ' She is up\nbefore the  bakery ' } }, [...QUOTABLE, long])!;
    expect(r.evidence).toEqual({ lively: 'She is up before the bakery' });
    expect(checkAnswer({ ...good, evidence: 'all of it' }, QUOTABLE)!.evidence).toEqual({});
    expect(checkAnswer({ ...good, evidence: { sociability: 7 } }, QUOTABLE)!.evidence).toEqual({});
  });

  it('a quote must come from one field: never across two, never from a label', () => {
    const sent = readerPrompt(makeCard({ name: 'Q', description: 'shy', personality: 'quiet' }), { userName: 'Sam' });
    const quote = (q: string) => checkAnswer({ ...good, sociability: 'reserved', evidence: { sociability: q } }, sent.quotable)!.evidence.sociability;
    expect(quote('shy')).toBe('shy');
    expect(quote('quiet')).toBe('quiet');
    expect(quote('shy quiet')).toBeUndefined();
    expect(quote('shy Personality: quiet')).toBeUndefined();
    expect(quote('Description: shy')).toBeUndefined();
  });

  it('each lore entry is a field of its own: a quote can come from one entry, never span two', () => {
    const entry = (content: string, order: number) => ({
      keys: [], secondary_keys: [], content, enabled: true, insertion_order: order, priority: 0, case_sensitive: false, selective: false,
      constant: true, use_regex: false, position: 'before_char' as const, name: '', comment: '', extensions: {}
    });
    const c = makeCard({ name: 'L', character_book: { name: '', description: '', recursive_scanning: false, extensions: {}, entries: [entry('She naps by day.', 0), entry('She hunts moths at night.', 1)] } });
    const sent = readerPrompt(c, { userName: 'Sam' });
    expect(sent.parts.find((p) => p.field === 'lore')!.text).toBe('She naps by day.\n\nShe hunts moths at night.');
    expect(sent.quotable).toEqual(['She naps by day.', 'She hunts moths at night.']);
    const quote = (q: string) => checkAnswer({ ...good, lively: 'night', evidence: { lively: q } }, sent.quotable)!.evidence.lively;
    expect(quote('She hunts moths at night.')).toBe('She hunts moths at night.');
    expect(quote('by day. She hunts')).toBeUndefined();
  });

  it('a lore entry cut by the budget is quotable only as far as it was sent', () => {
    const long = 'moth '.repeat(1000).trim();
    const c = makeCard({ name: 'L', character_book: { name: '', description: '', recursive_scanning: false, extensions: {}, entries: [
      { keys: [], secondary_keys: [], content: 'First.', enabled: true, insertion_order: 0, priority: 0, case_sensitive: false, selective: false, constant: true, use_regex: false, position: 'before_char', name: '', comment: '', extensions: {} },
      { keys: [], secondary_keys: [], content: long, enabled: true, insertion_order: 1, priority: 0, case_sensitive: false, selective: false, constant: true, use_regex: false, position: 'before_char', name: '', comment: '', extensions: {} }
    ] } });
    const sent = readerPrompt(c, { userName: 'Sam' });
    expect(sent.quotable).toHaveLength(2);
    expect(sent.quotable[0]).toBe('First.');
    expect(long.startsWith(sent.quotable[1]!)).toBe(true);
    expect(sent.quotable[1]!.length).toBeLessThan(long.length);
  });

  it('a quote from the reader\'s own prompt, not the card, is dropped', () => {
    expect(checkAnswer({ ...good, evidence: { sociability: 'says little, shy, quiet' } }, QUOTABLE)!.evidence).toEqual({});
  });
});

describe('the rules reader, over every style', () => {
  const rules = (path: string) => {
    const r = readByRules(card(path));
    return [r.sociability, r.closeness, r.lively];
  };

  it.each([
    // Prose and markdown need a model: the rules see no structured signal.
    ['trait-styles/prose.json', ['even', 'warm', 'any']],
    ['trait-styles/markdown.json', ['even', 'warm', 'any']],
    ['trait-styles/alichat.json', ['even', 'warm', 'any']],
    ['trait-styles/empty-personality.json', ['even', 'warm', 'any']],
    // W++: Personality("shy" + "kind" + "early riser").
    ['trait-styles/wpp.json', ['reserved', 'warm', 'morning']],
    // PList: [Ixa Wend's personality: cheerful, clingy, curious; ...].
    ['trait-styles/plist.json', ['outgoing', 'clingy', 'any']],
    // Tags only: Tsundere, night_owl.
    ['trait-styles/tags-only.json', ['even', 'aloof', 'night']],
    // shy and energetic, cold and clingy: each pair disagrees. nocturnal alone is clear. talkativeness 0.5 says nothing.
    ['trait-styles/conflicting-tags.json', ['even', 'warm', 'night']],
    // talkativeness 0.9.
    ['trait-styles/talkative.json', ['outgoing', 'warm', 'any']],
    // The V2 card: the tag "cheerful" and talkativeness "0.8" agree.
    ['cards/v2-pell.json', ['outgoing', 'warm', 'any']],
    // The V3 card: talkativeness 0.2 and the tag "night owl".
    ['cards/v3-tamsin.json', ['reserved', 'warm', 'night']]
  ] as const)('%s reads as %j', (path, expected) => {
    expect(rules(path)).toEqual(expected);
  });

  it('kuudere is both reserved and aloof; talkativeness that disagrees with a tag means neutral', () => {
    expect(readByRules(makeCard({ tags: ['kuudere'] }))).toMatchObject({ sociability: 'reserved', closeness: 'aloof' });
    expect(readByRules(makeCard({ tags: ['shy'], extensions: { talkativeness: 0.9 } })).sociability).toBe('even');
    expect(readByRules(makeCard({ tags: ['shy'], extensions: { talkativeness: 0.2 } })).sociability).toBe('reserved');
  });

  it('gives no interests and no quotes', () => {
    const r = readByRules(card('trait-styles/wpp.json'));
    expect([r.interests, r.evidence]).toEqual([[], {}]);
  });

  it('reads W++ and PList structure, not prose that happens to hold a word', () => {
    expect(wppWords('Personality("Shy" + "night-owl") and Likes("tea")')).toEqual(['shy', 'night owl', 'tea']);
    expect(plistWords("[Ada's personality: Calm, soft-spoken; Ada's clothes: coat]")).toEqual(['calm', 'soft spoken', 'coat']);
    expect(readByRules(makeCard({ description: 'She is shy around strangers and cold to rivals.' }))).toMatchObject({ sociability: 'even', closeness: 'warm' });
  });

  it('a hostile card is read by its tags like any other', () => {
    expect(readByRules(card('hostile/injection.json')).sociability).toBe('reserved');
  });
});

describe('which reading wins', () => {
  const rulesReading: TraitReading = { sociability: 'reserved', closeness: 'warm', lively: 'night', interests: [], evidence: {} };
  const modelReading: TraitReading = { sociability: 'outgoing', closeness: 'clingy', lively: 'any', interests: ['kites'], evidence: { sociability: 'loud' } };
  const later: TraitReading = { sociability: 'even', closeness: 'aloof', lively: 'morning', interests: [], evidence: {} };

  it('on import: the rules at once, then a model success replaces them', () => {
    const imported = applyReading(undefined, { kind: 'rules', cardKey: 'k1', reading: rulesReading });
    expect(effectiveTraits(imported)).toEqual({ sociability: 'reserved', closeness: 'warm', lively: 'night' });
    expect(shownTraits(imported).sociability.source).toBe('tags');
    expect(shownTraits(imported).closeness.source).toBe('default');
    const read = applyReading(imported, { kind: 'model-ok', cardKey: 'k1', reading: modelReading });
    expect(effectiveTraits(read)).toEqual({ sociability: 'outgoing', closeness: 'clingy', lively: 'any' });
    expect(shownTraits(read).sociability).toEqual({ value: 'outgoing', source: 'card', quote: 'loud' });
    expect(shownTraits(read).interests).toEqual({ value: ['kites'], source: 'card' });
  });

  it('on import, a failed call leaves the rules reader\'s values', () => {
    const imported = applyReading(undefined, { kind: 'rules', cardKey: 'k1', reading: rulesReading });
    const failed = applyReading(imported, { kind: 'model-failed', cardKey: 'k1' });
    expect(effectiveTraits(failed)).toEqual(effectiveTraits(imported));
    expect(failed.lastModelReading).toBe('failed');
  });

  it('a new card starts over: its rules at once, and the old card\'s model reading never kept, even when the call fails', () => {
    let s = applyReading(undefined, { kind: 'rules', cardKey: 'traits-v1:card-a', reading: rulesReading });
    s = applyReading(s, { kind: 'model-ok', cardKey: 'traits-v1:card-a', reading: modelReading });
    // A replaced or edited card has another hash: its rules reading replaces card A's model reading.
    s = applyReading(s, { kind: 'rules', cardKey: 'traits-v1:card-b', reading: later });
    expect(effectiveTraits(s)).toEqual({ sociability: 'even', closeness: 'aloof', lively: 'morning' });
    expect([s.readBy, s.cardKey, s.lastModelReading]).toEqual(['rules', 'traits-v1:card-b', undefined]);
    expect(shownTraits(s).interests).toEqual({ value: [], source: 'default' });
    expect(shownTraits(s).sociability.quote).toBeUndefined();
    // Its model call fails: the new card's rules values stay.
    s = applyReading(s, { kind: 'model-failed', cardKey: 'traits-v1:card-b' });
    expect(effectiveTraits(s)).toEqual({ sociability: 'even', closeness: 'aloof', lively: 'morning' });
    expect([s.readBy, s.lastModelReading]).toEqual(['rules', 'failed']);
    // A success replaces them.
    s = applyReading(s, { kind: 'model-ok', cardKey: 'traits-v1:card-b', reading: modelReading });
    expect([s.readBy, s.lastModelReading, effectiveTraits(s).sociability]).toEqual(['model', 'ok', 'outgoing']);
  });

  it('a model result for a new card with no rules reading first starts from neutral, never the old card', () => {
    let s = applyReading(undefined, { kind: 'model-ok', cardKey: 'traits-v1:card-a', reading: modelReading });
    s = applyReading(s, { kind: 'model-failed', cardKey: 'traits-v1:card-b' });
    expect(effectiveTraits(s)).toEqual({ sociability: 'even', closeness: 'warm', lively: 'any' });
    expect([s.readBy, s.cardKey]).toEqual(['default', 'traits-v1:card-b']);
  });

  it('the same card read again (a new reader version, or "read her card again"): a failure keeps the last good reading, even where the tags say otherwise', () => {
    let s = applyReading(undefined, { kind: 'rules', cardKey: 'traits-v1:card-a', reading: rulesReading });
    s = applyReading(s, { kind: 'model-ok', cardKey: 'traits-v1:card-a', reading: modelReading });
    // The rules never replace a model reading of the same card.
    s = applyReading(s, { kind: 'rules', cardKey: 'traits-v2:card-a', reading: rulesReading });
    s = applyReading(s, { kind: 'model-failed', cardKey: 'traits-v2:card-a' });
    expect(effectiveTraits(s)).toEqual({ sociability: 'outgoing', closeness: 'clingy', lively: 'any' });
    expect(shownTraits(s).sociability).toEqual({ value: 'outgoing', source: 'card', quote: 'loud' });
    expect([s.cardKey, s.lastModelReading]).toEqual(['traits-v1:card-a', 'failed']);
    // "Read her card again" on the same version, failing: still kept.
    s = applyReading(s, { kind: 'model-failed', cardKey: 'traits-v1:card-a' });
    expect(effectiveTraits(s).sociability).toBe('outgoing');
    // A success under the new version replaces it.
    s = applyReading(s, { kind: 'model-ok', cardKey: 'traits-v2:card-a', reading: later });
    expect(effectiveTraits(s)).toEqual({ sociability: 'even', closeness: 'aloof', lively: 'morning' });
    expect([s.cardKey, s.lastModelReading]).toEqual(['traits-v2:card-a', 'ok']);
  });

  it('the person\'s choices and chattiness carry over to a new card', () => {
    let s = setChattiness(setYours(NEUTRAL_STATE, { lively: 'night' }), 'high');
    s = applyReading(s, { kind: 'model-ok', cardKey: 'traits-v1:card-a', reading: modelReading });
    s = applyReading(s, { kind: 'rules', cardKey: 'traits-v1:card-b', reading: later });
    expect(shownTraits(s).lively).toEqual({ value: 'night', source: 'you' });
    expect(chattinessOf(s)).toEqual({ value: 'high', suggested: false });
  });

  it('a trait the person set survives every reading, and "use her card\'s" brings the reading back', () => {
    let s = setYours(NEUTRAL_STATE, { closeness: 'aloof', interests: ['chess'] });
    for (const e of [
      { kind: 'rules', cardKey: 'k', reading: rulesReading },
      { kind: 'model-ok', cardKey: 'k', reading: modelReading },
      { kind: 'model-failed', cardKey: 'k' },
      { kind: 'model-ok', cardKey: 'k2', reading: later }
    ] as const) {
      s = applyReading(s, e);
      expect(shownTraits(s).closeness).toEqual({ value: 'aloof', source: 'you' });
      expect(shownTraits(s).interests).toEqual({ value: ['chess'], source: 'you' });
    }
    s = useCards(s, 'closeness');
    expect(shownTraits(s).closeness).toEqual({ value: 'aloof', source: 'card' });
    s = useCards(s, 'interests');
    expect(shownTraits(s).interests).toEqual({ value: [], source: 'default' });
  });
});

describe('chattiness', () => {
  it('her sociability suggests it: reserved low, even medium, outgoing high', () => {
    expect([suggestChattiness('reserved'), suggestChattiness('even'), suggestChattiness('outgoing')]).toEqual(['low', 'medium', 'high']);
  });

  it("once the person picks one, a reading never changes it", () => {
    let s = applyReading(undefined, { kind: 'model-ok', cardKey: 'k', reading: { sociability: 'outgoing', closeness: 'warm', lively: 'any', interests: [], evidence: {} } });
    expect(chattinessOf(s)).toEqual({ value: 'high', suggested: true });
    s = setChattiness(s, 'low');
    s = applyReading(s, { kind: 'model-ok', cardKey: 'k2', reading: { sociability: 'reserved', closeness: 'warm', lively: 'any', interests: [], evidence: {} } });
    expect(chattinessOf(s)).toEqual({ value: 'low', suggested: false });
  });

  it('the suggestion follows the person\'s own sociability when they set one', () => {
    const s = setYours(NEUTRAL_STATE, { sociability: 'reserved' });
    expect(chattinessOf(s)).toEqual({ value: 'low', suggested: true });
  });
});

describe('the cache key', () => {
  const digest = async (b: Uint8Array) => new Uint8Array(await webcrypto.subtle.digest('SHA-256', b));

  it('is the reader version and the SHA-256 of the canonical card JSON', async () => {
    const c = card('cards/v3-tamsin.json');
    const expected = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(toV3Json(c)))).toString('hex');
    expect(await traitCacheKey(c, digest)).toBe(`traits-v${READER_VERSION}:${expected}`);
  });

  it('the same card in any format or key order gives the same key; a changed card does not', async () => {
    const v2 = card('cards/v2-pell.json');
    const fromPng = readCard(fixtureBytes('png/chara-v2.png'));
    expect(fromPng.ok).toBe(true);
    if (!fromPng.ok) return;
    expect(await traitCacheKey(fromPng.card, digest)).toBe(await traitCacheKey(v2, digest));
    expect(await traitCacheKey({ ...v2, description: `${v2.description} ` }, digest)).not.toBe(await traitCacheKey(v2, digest));
  });

  it('cardHashOf gives the card part, so a new reader version is the same card', async () => {
    const c = card('cards/v3-tamsin.json');
    const key = await traitCacheKey(c, digest);
    expect(cardHashOf(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(cardHashOf(key.replace(/^traits-v\d+/, 'traits-v99'))).toBe(cardHashOf(key));
  });

  it('the digest is injected: no hashing of its own', async () => {
    const seen: number[] = [];
    const key = await traitCacheKey(makeCard(), async (b) => {
      seen.push(b.length);
      return Uint8Array.of(0xab, 0x01);
    });
    expect(key).toBe(`traits-v${READER_VERSION}:ab01`);
    expect(seen).toHaveLength(1);
  });
});

describe('the plain helper', () => {
  it('has no art, a short neutral description, neutral traits and medium chattiness', () => {
    const h = plainHelper();
    expect(h.card.name).toBe(DEFAULT_HELPER_NAME);
    expect(h.card.assets).toBeUndefined();
    expect(h.card.character_book).toBeUndefined();
    expect(h.card.description.length).toBeLessThan(200);
    expect(effectiveTraits(h.traits)).toEqual({ sociability: 'even', closeness: 'warm', lively: 'any' });
    expect(shownTraits(h.traits).interests).toEqual({ value: [], source: 'default' });
    expect(h.chattiness).toBe('medium');
    expect(chattinessOf(h.traits).value).toBe('medium');
  });

  it('takes the name the person gives, trimmed; a blank one gives the default', () => {
    expect(plainHelper('  Pip  ').card.name).toBe('Pip');
    expect(plainHelper('   ').card.name).toBe(DEFAULT_HELPER_NAME);
  });

  it('round-trips like any card', () => {
    const h = plainHelper('Pip');
    const r = readCard(toV3Json(h.card));
    expect(r.ok && r.card).toEqual(h.card);
  });
});
