// T10 and T12 (docs/mcp-design.md 5.7, 5.8): what other windows may say to core. A card answer carries a
// presentation id and a button and nothing else is read; a button not offered is a Skip; a setup can't
// give Familiar's own headers. Settings' secret saves go through a one-use reservation.
import { describe, expect, it } from 'vitest';
import { buttonsOf, createCardDesk, type ConsentCard } from '../../src/index.ts';
import { Owner, BUSY_WORDS, type OwnerPorts } from '../../src/mcp/owner.ts';
import { setupProblems, type ServerSetup } from '../../src/mcp/setup.ts';
import { memorySettingsStore } from '../../src/settings/store.ts';
import { testPaths } from './fake.ts';

const card = (presentation: string, extra: Partial<ConsentCard> = {}): ConsentCard => ({ id: 'step-1', tool: 'files__write', arguments: { path: 'a' }, doing: 'writing a', askedAt: 0, presentation, ...extra });

describe('T10: card answers from another window (5.7)', () => {
  it('carry a presentation id and a button only; each presentation answers once; anything else answers nothing', async () => {
    const desk = createCardDesk();
    const plain = desk.port.ask(card('p1'));
    expect(desk.showing().map((s) => [s.card.presentation, s.buttons])).toEqual([['p1', ['yes', 'skip']]]);
    // Not an answer: not an object, no presentation, too long, not a string button, an unknown presentation.
    for (const m of [null, 'p1', { button: 'yes' }, { presentation: 'p1' }, { presentation: 'x'.repeat(65), button: 'yes' }, { presentation: 'p1', button: 1 }, { presentation: 'p9', button: 'yes' }]) expect(desk.answer(m)).toEqual({ kind: 'ignored' });
    // Extra fields are never read: the Yes is to the card as it was shown.
    expect(desk.answer({ presentation: 'p1', button: 'yes', facts: { tool: 'other' }, arguments: { path: 'b' }, tool: 'other' })).toEqual({ kind: 'answered', yes: true, own: false });
    expect(await plain).toBe(true);
    // Answered once: the same answer again is nothing.
    expect(desk.answer({ presentation: 'p1', button: 'yes' })).toEqual({ kind: 'ignored' });
    // A button the card didn't offer ("May run on its own" on a card without it, the old "always", or
    // anything unknown) is a Skip.
    const noOwn = desk.port.ask(card('p2'));
    expect(desk.answer({ presentation: 'p2', button: 'own' })).toEqual({ kind: 'answered', yes: false, own: false });
    expect(await noOwn).toBe(false);
    const odd = desk.port.ask(card('p3', { own: 'May run on its own.' }));
    expect(desk.answer({ presentation: 'p3', button: 'always' })).toEqual({ kind: 'answered', yes: false, own: false });
    expect(await odd).toBe(false);
    // "May run on its own", where offered: the card answers `own`, a Yes that asks for the grant; the journal
    // checks the presentation and its facts before it saves anything (tests/mcp/journal.test.ts).
    const withOwn = desk.port.ask(card('p4', { own: 'May run on its own.' }));
    expect(buttonsOf(card('p4', { own: 'May run on its own.' }))).toEqual(['yes', 'own', 'skip']);
    expect(desk.answer({ presentation: 'p4', button: 'own' })).toEqual({ kind: 'answered', yes: true, own: true });
    expect(await withOwn).toBe('own');
    // A card withdrawn (its call stopped) is gone: a late answer is nothing.
    const stop = new AbortController();
    const withdrawn = desk.port.ask(card('p5'), stop.signal);
    stop.abort();
    expect(await withdrawn).toBe(false);
    expect(desk.answer({ presentation: 'p5', button: 'yes' })).toEqual({ kind: 'ignored' });
    expect(desk.showing()).toEqual([]);
  });

  it("refuses a setup giving any of Familiar's own headers, whatever their case", () => {
    const remote = (name: string): ServerSetup => ({ kind: 'remote', id: 'r1', label: 'R', url: 'https://h.example/mcp', transport: 'http', headers: [[name, 'v']] });
    for (const name of ['Mcp-Session-Id', 'MCP-PROTOCOL-VERSION', 'last-event-id', 'Content-Type', 'Accept', 'Host', 'Mcp-Method', 'mcp-name', 'Mcp-Param-Region', 'MCP-PARAM-x']) {
      expect(setupProblems(remote(name), testPaths).join(' '), name).toMatch(/Familiar's own to set|doesn't send the Host/);
    }
    expect(setupProblems(remote('X-Client'), testPaths)).toEqual([]);
  });
});

describe('T12: reservations for a secret\'s save (5.8)', () => {
  const ports = (): OwnerPorts => ({ store: memorySettingsStore(), forget: async () => {}, addresses: { add: async () => ({ id: 'a1' }), remove: async () => {} }, secrets: { delete: async () => {} }, now: () => 0 });
  const local: ServerSetup = { kind: 'local', id: 'l1', label: 'Files', program: 'npx', args: ['-y', 'files@1.0.0'], cwd: 'C:\\work', env: [], secrets: ['TOKEN'] };

  it('one fresh grant for one ref of a saved server, held until acknowledged by its id and ref, used once', async () => {
    const p = ports();
    const owner = await Owner.open(p);
    expect((await owner.add(local)).ok).toBe(true);
    expect(owner.reserve('server:l1:OTHER')).toMatchObject({ ok: false });
    expect(owner.reserve('server:zz:TOKEN')).toMatchObject({ ok: false });
    const r = owner.reserve('server:l1:TOKEN');
    if (!('grant' in r)) throw new Error('no grant');
    // While held: no other change, and no second grant.
    expect(owner.reserve('server:l1:TOKEN')).toMatchObject({ ok: false, words: BUSY_WORDS });
    expect(await owner.remove('l1', async () => {})).toMatchObject({ ok: false, words: BUSY_WORDS });
    // Unknown, mismatched or ill-formed acknowledgements do nothing.
    expect(owner.acknowledge('nope', 'server:l1:TOKEN')).toBe(false);
    expect(owner.acknowledge(r.grant.id, 'server:l1:OTHER')).toBe(false);
    expect(owner.acknowledge({ id: r.grant.id }, r.grant.ref)).toBe(false);
    expect(owner.busy).toBe(true);
    // The right one releases; the same again does nothing.
    expect(owner.acknowledge(r.grant.id, r.grant.ref)).toBe(true);
    expect(owner.busy).toBe(false);
    expect(owner.acknowledge(r.grant.id, r.grant.ref)).toBe(false);
    // A second grant has a fresh id.
    const r2 = owner.reserve('server:l1:TOKEN');
    if (!('grant' in r2)) throw new Error('no grant');
    expect(r2.grant.id).not.toBe(r.grant.id);
    owner.acknowledge(r2.grant.id, r2.grant.ref);
  });

  it('a grant Settings never acknowledged holds the owner until the exe restarts; the old grant is nothing after', async () => {
    const p = ports();
    const one = await Owner.open(p);
    await one.add(local);
    const r = one.reserve('server:l1:TOKEN');
    if (!('grant' in r)) throw new Error('no grant');
    expect(await one.remove('l1', async () => {})).toMatchObject({ ok: false });
    // The restart: a new owner over the same store holds nothing, and the old grant acknowledges nothing.
    const two = await Owner.open(p);
    expect(two.busy).toBe(false);
    expect(two.acknowledge(r.grant.id, r.grant.ref)).toBe(false);
    expect((await two.remove('l1', async () => {})).ok).toBe(true);
  });
});
