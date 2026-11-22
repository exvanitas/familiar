// The owner of durable tool config (docs/mcp-design.md 5.1 to 5.3, B6): one effect at a time, the steps
// of each change with its one mark, the rollback, tombstones, repair in a fresh start, and failing closed.

import { describe, expect, it } from 'vitest';
import { addressIdentity, BUSY_WORDS, Owner, REMOVED_ID_WORDS, OWNER_KEY, UNFINISHED_WORDS, WAITING_WORDS, type OwnerPorts } from '../../src/mcp/owner.ts';
import type { ServerSetup } from '../../src/mcp/setup.ts';
import { memorySettingsStore, type SettingsStore } from '../../src/settings/store.ts';

const local = (id: string, secrets: string[] = []): ServerSetup => ({ kind: 'local', id, label: 'Files', program: 'npx', args: ['-y', 'files@1.0.0'], cwd: 'C:\\work', env: [], secrets });
const remote = (id: string, url = 'https://h.example/mcp'): ServerSetup => ({ kind: 'remote', id, label: 'Remote', url, transport: 'http', headers: [] });

function ports(store: SettingsStore = memorySettingsStore(), over: Partial<OwnerPorts> = {}) {
  const log: string[] = [];
  let now = 0;
  const addresses = new Map<string, string>();
  let n = 0;
  const p: OwnerPorts = {
    store,
    forget: async (id) => void log.push(`forget ${id}`),
    addresses: {
      add: async ({ url }) => {
        const id = `addr-${++n}`;
        addresses.set(id, url);
        log.push(`address_add ${url}`);
        return { id };
      },
      remove: async (id) => {
        addresses.delete(id);
        log.push(`address_remove ${id}`);
      },
      list: async () => [...addresses].map(([id, url]) => ({ id, kind: 'server', url }))
    },
    secrets: { delete: async (ref) => void log.push(`secret_delete ${ref}`) },
    now: () => now,
    ...over
  };
  return { p, log, addresses, advance: (ms: number) => (now += ms) };
}

const stored = async (store: SettingsStore) => (await store.get(OWNER_KEY))?.value as any;

describe('B6: the exe\'s address identity', () => {
  it('case, punycode, the default port, one trailing dot and trailing slashes: one identity', () => {
    const same = ['https://h.example/mcp', 'HTTPS://H.Example/mcp/', 'https://h.example:443/mcp', 'https://h.example./mcp', 'https://h.example/mcp//'];
    expect(new Set(same.map(addressIdentity))).toEqual(new Set(['https://h.example/mcp']));
    expect(addressIdentity('https://bücher.example/x')).toBe('https://xn--bcher-kva.example/x');
    expect(addressIdentity('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
    expect(addressIdentity('https://h.example:8443/mcp')).not.toBe(addressIdentity('https://h.example/mcp'));
    expect(addressIdentity('https://h.example../mcp')).toBeUndefined();
  });
});

describe('5.1: one durable effect at a time', () => {
  it("the catalog write is admitted like any effect: with its store write held, a choice is refused busy, not lost; while a choice is in flight, the catalog write is skipped", async () => {
    const base = memorySettingsStore();
    const gates: (() => void)[] = [];
    let hold = false;
    let inFlight = 0;
    let most = 0;
    const store: SettingsStore = {
      ...base,
      putIf: async (k, r, g) => {
        inFlight++;
        most = Math.max(most, inFlight);
        try {
          if (hold) await new Promise<void>((res) => gates.push(res));
          return await base.putIf(k, r, g);
        } finally {
          inFlight--;
        }
      }
    };
    const owner = await Owner.open(ports(store).p);
    expect(await owner.add(local('l1'))).toEqual({ ok: true });
    hold = true;
    const seen = owner.seen('l1', [{ name: 'echo', fingerprint: 'f1' }]);
    const choice = owner.grant('l1', 'echo', { fingerprint: 'f1', setupFingerprint: 'x' });
    await new Promise((r) => setTimeout(r, 5));
    hold = false;
    gates.splice(0).forEach((g) => g());
    await seen;
    expect(most).toBe(1);
    expect(await choice).toEqual({ ok: false, words: BUSY_WORDS });
    expect(owner.server('l1')!.tools).toEqual([{ name: 'echo', fingerprint: 'f1' }]);
    // The other way round: the choice holds the owner, and the catalog write is skipped (re-derived at the
    // next listing), never a second write on the same revision.
    hold = true;
    const second = owner.grant('l1', 'echo', { fingerprint: 'f1', setupFingerprint: 'x' });
    await new Promise((r) => setTimeout(r, 1));
    await owner.seen('l1', [{ name: 'echo', fingerprint: 'f2' }]);
    hold = false;
    gates.splice(0).forEach((g) => g());
    expect(await second).toEqual({ ok: true });
    expect(most).toBe(1);
    expect(owner.server('l1')!.tools).toEqual([{ name: 'echo', fingerprint: 'f1' }]);
  });

  it('a second change while one is in flight is refused at once, and changes nothing', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const t = ports();
    const owner = await Owner.open({ ...t.p, addresses: { ...t.p.addresses, add: async (spec) => (await held, t.p.addresses.add(spec)) } });
    const adding = owner.add(remote('r1'));
    await Promise.resolve();
    expect(owner.busy).toBe(true);
    expect(await owner.add(local('l1'))).toEqual({ ok: false, words: BUSY_WORDS });
    expect(owner.server('l1')).toBeUndefined();
    // The words change after 10 s; nothing else does.
    expect(owner.saving()?.words).toBe('Saving…');
    t.advance(10_000);
    expect(owner.saving()?.words).toBe(WAITING_WORDS);
    release();
    expect(await adding).toEqual({ ok: true });
    expect(owner.busy).toBe(false);
  });

  it('a remote add: the mark first, then the dialog, then the record and the mark cleared in one commit', async () => {
    const store = memorySettingsStore();
    let markAtDialog: unknown;
    const t = ports(store);
    const owner = await Owner.open({ ...t.p, addresses: { ...t.p.addresses, add: async (spec) => ((markAtDialog = (await stored(store)).mark), t.p.addresses.add(spec)) } });
    expect(await owner.add(remote('r1'))).toEqual({ ok: true });
    expect(markAtDialog).toEqual({ kind: 'add-remote', server: 'r1', identity: 'https://h.example/mcp' });
    const doc = await stored(store);
    expect(doc.mark).toBeUndefined();
    expect(doc.servers.r1).toMatchObject({ setup: { address: 'addr-1' }, key: 'remote', enabled: false });
    // The same address under another spelling is refused before any dialog.
    expect(await owner.add(remote('r2', 'https://H.example:443/mcp/'))).toMatchObject({ ok: false, words: expect.stringMatching(/Another server, Remote, already uses this address/) });
    expect(t.log.filter((l) => l.startsWith('address_add'))).toHaveLength(1);
  });

  it('a declined dialog clears the mark: not saved', async () => {
    const store = memorySettingsStore();
    const t = ports(store);
    const owner = await Owner.open({ ...t.p, addresses: { ...t.p.addresses, add: async () => { throw new Error('declined'); } } });
    expect(await owner.add(remote('r1'))).toEqual({ ok: false, words: 'You chose not to allow this address.' });
    expect(owner.mark).toBeUndefined();
    expect(owner.server('r1')).toBeUndefined();
  });

  it('an edit that drops a secret: record and mark together, then the delete; a failed delete keeps the mark, refuses other changes but not starts, and Retry finishes', async () => {
    let fail = true;
    const t = ports();
    const owner = await Owner.open({ ...t.p, secrets: { delete: async (ref) => { if (fail) throw new Error('locked'); t.log.push(`secret_delete ${ref}`); } } });
    await owner.add(local('l1', ['TOKEN']));
    expect(await owner.edit('l1', local('l1', []), false)).toMatchObject({ ok: false, words: 'Stop the server before changing it.' });
    expect(await owner.edit('l1', local('l1', []), true)).toMatchObject({ ok: false, words: expect.stringMatching(/cleanup not finished/) });
    expect(owner.mark).toEqual({ kind: 'edit', server: 'l1', dropped: ['server:l1:TOKEN'] });
    expect(owner.server('l1')!.setup).toMatchObject({ secrets: [] });
    expect(await owner.update('l1', (s) => ({ ...s, enabled: true }))).toEqual({ ok: false, words: UNFINISHED_WORDS });
    const start = owner.admit('start', { start: true });
    expect('release' in start).toBe(true);
    if ('release' in start) start.release();
    fail = false;
    expect(await owner.retry()).toEqual({ ok: true });
    expect(owner.mark).toBeUndefined();
    expect(t.log).toContain('secret_delete server:l1:TOKEN');
  });

  it('remove: stop awaited first, then a tombstone; its items done one by one; its choices go; the id and the key are never reused', async () => {
    const t = ports();
    const owner = await Owner.open(t.p);
    await owner.add(local('l1', ['TOKEN']));
    await owner.grant('l1', 'echo', { fingerprint: 'f', setupFingerprint: 's' });
    // A server whose id begins like l1's, so its choice must survive l1's removal.
    await owner.add({ ...local('l10'), label: 'Other' });
    await owner.choose('l10', 'echo', { policy: 'deny', fingerprint: 'f', setupFingerprint: 's' });
    expect(await owner.remove('l1', async () => void t.log.push('stopped'))).toEqual({ ok: true });
    expect(t.log).toEqual(['stopped', 'forget l1', 'secret_delete server:l1:TOKEN']);
    expect(owner.server('l1')).toBeUndefined();
    expect(owner.tombstones().l1).toEqual({ key: 'files' });
    expect(Object.keys(owner.choices())).toEqual([JSON.stringify(['l10', 'echo'])]);
    expect(await owner.add(local('l1'))).toMatchObject({ ok: false, words: REMOVED_ID_WORDS });
    await owner.add(local('l2'));
    expect(owner.server('l2')!.key).toBe('files2');
  });
});

describe('5.2 and 5.3: repair in a fresh start', () => {
  it('a remote add cut off after its dialog: the mark is rolled back and the orphan address removed; address_add is never repeated', async () => {
    const store = memorySettingsStore();
    const t = ports(store);
    // Life 1: the dialog said yes, then the app died before the record's commit.
    let die!: () => void;
    const dead = new Promise<never>(() => {});
    const one = await Owner.open({ ...t.p, addresses: { ...t.p.addresses, add: async (spec) => { await t.p.addresses.add(spec); die(); return dead; } } });
    void one.add(remote('r1'));
    await new Promise<void>((r) => (die = r));
    expect((await stored(store)).mark).toMatchObject({ kind: 'add-remote' });
    expect(t.addresses.size).toBe(1);
    // Life 2, a fresh exe.
    const two = await Owner.open(t.p);
    expect(await two.repair()).toEqual({ ok: true });
    expect(two.mark).toBeUndefined();
    expect(two.server('r1')).toBeUndefined();
    expect(t.addresses.size).toBe(0);
    expect(t.log.filter((l) => l.startsWith('address_add'))).toHaveLength(1);
  });

  it("a remote removal cut off after address_remove, before its done commit: repair takes the exe's not-saved for the gone address as done", async () => {
    const store = memorySettingsStore();
    const addresses = new Set<string>();
    const removals: string[] = [];
    // The exe's own answer: removing an address it doesn't hold is refused `not-saved` (address_remove).
    const exe: OwnerPorts['addresses'] = {
      add: async () => (addresses.add('addr-1'), { id: 'addr-1' }),
      remove: async (id) => {
        removals.push(id);
        if (!addresses.delete(id)) throw { kind: 'not-saved', message: 'no such address' };
      },
      list: async () => [...addresses].map((id) => ({ id, kind: 'server', url: 'https://h.example/mcp' }))
    };
    let dead = false;
    const dying: SettingsStore = { ...store, putIf: (k, r, g) => (dead ? new Promise<boolean>(() => {}) : store.putIf(k, r, g)) };
    const one = await Owner.open({ ...ports(store).p, store: dying, addresses: { ...exe, remove: async (id) => { await exe.remove(id); dead = true; } } });
    expect(await one.add(remote('r1'))).toEqual({ ok: true });
    void one.remove('r1', async () => {});
    for (let i = 0; i < 50 && !dead; i++) await new Promise((r) => setTimeout(r, 1));
    expect(dead).toBe(true);
    // A fresh exe: the address is gone, the mark and the unfinished tombstone stay.
    const two = await Owner.open({ ...ports(store).p, addresses: exe });
    expect(two.mark).toEqual({ kind: 'remove', server: 'r1' });
    expect(await two.repair()).toEqual({ ok: true });
    expect(two.mark).toBeUndefined();
    expect(two.server('r1')).toBeUndefined();
    expect(two.tombstones().r1).toEqual({ key: 'remote' });
    expect(await two.add(local('l2'))).toEqual({ ok: true });
    expect(removals).toEqual(['addr-1', 'addr-1']);
  });

  it('a removal cut off mid-cleanup: the next start finishes it from where it stopped', async () => {
    const store = memorySettingsStore();
    let forgetFails = true;
    const t = ports(store);
    const one = await Owner.open({ ...t.p, forget: async (id) => { if (forgetFails) throw new Error('exe gone'); t.log.push(`forget ${id}`); } });
    await one.add(local('l1', ['A']));
    expect(await one.remove('l1', async () => {})).toMatchObject({ ok: false, words: expect.stringMatching(/Removing; cleanup not finished/) });
    expect((await stored(store)).tombstones.l1).toMatchObject({ forget: false, secrets: { 'server:l1:A': false } });
    forgetFails = false;
    const two = await Owner.open({ ...t.p, forget: async (id) => void t.log.push(`forget ${id}`) });
    expect(await two.repair()).toEqual({ ok: true });
    expect(two.server('l1')).toBeUndefined();
    expect(two.tombstones().l1).toEqual({ key: 'files' });
    expect(t.log.filter((l) => l === 'forget l1')).toHaveLength(1);
  });

  it("the sweep never removes the address of a saved record it can't read, and a removal that fails leaves repair unfinished", async () => {
    const store = memorySettingsStore();
    const t = ports(store);
    const one = await Owner.open(t.p);
    expect(await one.add(remote('r1'))).toEqual({ ok: true });
    // The record loses a field: unreadable, but its address is still its own (removing it deletes the key).
    const doc = await stored(store);
    delete doc.servers.r1.tools;
    await store.put(OWNER_KEY, { v: 1, value: doc });
    const two = await Owner.open(t.p);
    expect(two.unreadableServers()).toEqual(['r1']);
    expect(await two.repair()).toEqual({ ok: true });
    expect([...t.addresses.keys()]).toEqual(['addr-1']);
    // A true orphan whose removal fails: repair says so.
    t.addresses.set('orphan', 'https://o.example/mcp');
    const three = await Owner.open({ ...t.p, addresses: { ...t.p.addresses, remove: async () => { throw new Error('exe busy'); } } });
    expect(await three.repair()).toMatchObject({ ok: false });
    // One already gone (the exe's not-saved) counts as removed.
    const four = await Owner.open({ ...t.p, addresses: { ...t.p.addresses, remove: async () => { throw { kind: 'not-saved', message: 'no such address' }; } } });
    expect(await four.repair()).toEqual({ ok: true });
  });
});

describe('5.1: failing closed', () => {
  it('an unreadable choice loads as an explicit "ask", never "always" and never absent; an unreadable server is neither listed nor overwritten', async () => {
    const store = memorySettingsStore();
    await store.put(OWNER_KEY, {
      v: 1,
      value: {
        rev: 3,
        servers: { bad: { setup: { kind: 'weird' } }, l1: { setup: local('l1'), key: 'files', enabled: true, limits: {}, tools: [] } },
        choices: { [JSON.stringify(['l1', 'echo'])]: { policy: 'allow', fingerprint: 7 }, [JSON.stringify(['l1', 'note'])]: { policy: 'deny', fingerprint: 'f', setupFingerprint: 's' } },
        keys: ['files'],
        tombstones: {}
      } as never
    });
    const owner = await Owner.open(ports(store).p);
    expect(owner.choices()).toEqual({ [JSON.stringify(['l1', 'echo'])]: { policy: 'ask', fingerprint: '', setupFingerprint: '' }, [JSON.stringify(['l1', 'note'])]: { policy: 'deny', fingerprint: 'f', setupFingerprint: 's' } });
    expect(owner.servers().map((s) => s.setup.id)).toEqual(['l1']);
    expect(owner.unreadableServers()).toEqual(['bad']);
    expect(await owner.update('bad', (s) => s)).toMatchObject({ ok: false });
    await owner.update('l1', (s) => ({ ...s, enabled: false }));
    expect((await stored(store)).servers.bad).toEqual({ setup: { kind: 'weird' } });
  });

  it("an Add never takes an unreadable server's address: not by the URL, and not by the id the exe gives back", async () => {
    // The exe's dialog: one address id per URL, as the exe keeps one per identity.
    const store = memorySettingsStore();
    const t = ports(store);
    const byUrl = new Map<string, string>();
    const p: OwnerPorts = { ...t.p, addresses: { ...t.p.addresses, add: async (spec) => byUrl.get(spec.url) ? { id: byUrl.get(spec.url)! } : t.p.addresses.add(spec).then((a) => (byUrl.set(spec.url, a.id), a)) } };
    const one = await Owner.open(p);
    expect(await one.add(remote('A', 'https://a.example/mcp'))).toEqual({ ok: true });
    expect(await one.add(remote('C', 'https://c.example/mcp'))).toEqual({ ok: true });
    // A loses a header's shape, and C its URL: both unreadable, each still holding its address.
    const doc = await stored(store);
    doc.servers.A.setup.headers = [null];
    doc.servers.C.setup.url = 42;
    await store.put(OWNER_KEY, { v: 1, value: doc });
    const two = await Owner.open(p);
    expect(two.unreadableServers()).toEqual(['A', 'C']);
    // By the URL: refused before any dialog.
    expect(await two.add(remote('B', 'https://A.example:443/mcp/'))).toMatchObject({ ok: false, words: expect.stringMatching(/already uses this address/) });
    // By the id the exe gives back for C's address (its URL can't be read here): refused, the address kept.
    expect(await two.add(remote('D', 'https://c.example/mcp'))).toMatchObject({ ok: false, words: expect.stringMatching(/already uses this address/) });
    expect(two.server('B')).toBeUndefined();
    expect(two.server('D')).toBeUndefined();
    expect([...t.addresses.keys()].sort()).toEqual(['addr-1', 'addr-2']);
    const raw = await stored(store);
    expect([raw.servers.A.setup.address, raw.servers.C.setup.address]).toEqual(['addr-1', 'addr-2']);
    expect(two.mark).toBeUndefined();
  });

  it('a record of another version: nothing loads, and nothing is written', async () => {
    const store = memorySettingsStore();
    await store.put(OWNER_KEY, { v: 2, value: { future: true } });
    const owner = await Owner.open(ports(store).p);
    expect(owner.unreadable).toBe(true);
    expect(owner.servers()).toEqual([]);
    expect(await owner.add(local('l1'))).toMatchObject({ ok: false });
    expect(await store.get(OWNER_KEY)).toEqual({ v: 2, value: { future: true } });
  });
});

describe('5.1: the owner keeps built-in choices too', () => {
  it("the gate's policy carries server and built-in choices, with the revoke overlay on top at once", async () => {
    const { McpClient, BUILT_IN } = await import('../../src/mcp/client.ts');
    const t = ports();
    const client = await McpClient.open({ store: t.p.store, processes: { start: async () => ({ run: 'x' }), write: async () => {}, stop: async () => {}, forget: async () => {} }, net: { fetch: async () => { throw new Error('no'); }, read: async () => new Uint8Array(0), cancel: async () => {} }, addresses: t.p.addresses, secrets: t.p.secrets, clock: { now: () => 0, setTimer: () => undefined } });
    await client.choose(BUILT_IN, 'note_add', { policy: 'deny', fingerprint: '', setupFingerprint: '' });
    await client.choose(BUILT_IN, 'note_search', { policy: 'allow', fingerprint: '', setupFingerprint: '' });
    expect(client.policy([])).toEqual({ perTool: { note_add: 'deny', note_search: 'allow' } });
    void client.revoke(BUILT_IN, 'note_search', 'ask');
    expect(client.policy([]).perTool).toEqual({ note_add: 'deny', note_search: 'ask' });
  });

  it('an Allow for a built-in off the notes-and-reminders list is refused at save; one in the record loads as ask, and the gate asks', async () => {
    const { McpClient, BUILT_IN } = await import('../../src/mcp/client.ts');
    const { gateFor } = await import('../../src/journal/gate.ts');
    const t = ports();
    const open = () => McpClient.open({ store: t.p.store, processes: { start: async () => ({ run: 'x' }), write: async () => {}, stop: async () => {}, forget: async () => {} }, net: { fetch: async () => { throw new Error('no'); }, read: async () => new Uint8Array(0), cancel: async () => {} }, addresses: t.p.addresses, secrets: t.p.secrets, clock: { now: () => 0, setTimer: () => undefined } });
    const client = await open();
    const send = { name: 'send_message', kind: 'effect' } as never;
    await expect(client.choose(BUILT_IN, 'send_message', { policy: 'allow', fingerprint: '', setupFingerprint: '' })).rejects.toThrow(/Only Familiar's own notes and reminders run without asking/);
    await expect(client.choose(BUILT_IN, 'note_add', { policy: 'own', fingerprint: '', setupFingerprint: '' })).rejects.toThrow();
    // Written by something older, straight into the record: it loads as ask, and the gate asks.
    await client.choose(BUILT_IN, 'note_search', { policy: 'allow', fingerprint: '', setupFingerprint: '' });
    const stored = (await t.p.store.get(OWNER_KEY))!;
    const value = JSON.parse(JSON.stringify(stored.value));
    value.choices[JSON.stringify([BUILT_IN, 'send_message'])] = { policy: 'allow', fingerprint: '', setupFingerprint: '' };
    value.choices[JSON.stringify(['l1', 'echo'])] = { policy: 'allow', fingerprint: 'f', setupFingerprint: 's' };
    await t.p.store.put(OWNER_KEY, { v: stored.v, value });
    const reopened = await open();
    expect(reopened.choices()[JSON.stringify([BUILT_IN, 'send_message'])]?.policy).toBe('ask');
    // An old "always" for a server's tool loads as ask too.
    expect(reopened.choices()[JSON.stringify(['l1', 'echo'])]?.policy).toBe('ask');
    expect(gateFor('send_message', send, reopened.policy([]))).toBe('ask');
    // Even a policy that says allow, from anywhere, asks for it.
    expect(gateFor('send_message', send, { perTool: { send_message: 'allow' } })).toBe('ask');
  });
});
