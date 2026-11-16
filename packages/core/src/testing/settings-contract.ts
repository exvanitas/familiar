// The settings store's contract. The memory store and the IndexedDB store both run these cases. Plain
// async checks, so any runner can drive them.

import type { SettingsStore } from '../settings/store.ts';

export interface SettingsStoreHarness {
  /** A fresh, empty store. */
  open(): Promise<SettingsStore>;
  /** The same store opened again, as after a restart. Absent where there's nothing to reopen. */
  reopen?(): Promise<SettingsStore>;
}

export interface SettingsContractCase {
  readonly name: string;
  run(h: SettingsStoreHarness): Promise<void>;
}

function check(ok: unknown, why: string): asserts ok {
  if (!ok) throw new Error(why);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const refused = (p: Promise<unknown>) => p.then(() => false, () => true);

export const settingsStoreContract: readonly SettingsContractCase[] = [
  {
    name: 'a key never written reads as undefined',
    async run(h) {
      const s = await h.open();
      check((await s.get('mcp.server.none')) === undefined, 'a missing key read as something');
    }
  },
  {
    name: 'a record reads back with its version, and a second write replaces it',
    async run(h) {
      const s = await h.open();
      await s.put('a', { v: 1, value: { name: 'one', list: [1, 2, { deep: true }], none: null } });
      check(same(await s.get('a'), { v: 1, value: { name: 'one', list: [1, 2, { deep: true }], none: null } }), 'the record changed');
      await s.put('a', { v: 2, value: 'two' });
      check(same(await s.get('a'), { v: 2, value: 'two' }), 'the second write did not replace the first');
    }
  },
  {
    name: 'values are copied in and out',
    async run(h) {
      const s = await h.open();
      const value = { list: ['x'] };
      await s.put('c', { v: 1, value });
      value.list.push('changed after the write');
      const out = await s.get('c');
      check(same(out?.value, { list: ['x'] }), 'a change after the write reached the store');
      (out!.value as { list: string[] }).list.push('changed after the read');
      check(same((await s.get('c'))?.value, { list: ['x'] }), 'a change to a read value reached the store');
    }
  },
  {
    name: 'delete removes a record, and deleting a missing one is fine',
    async run(h) {
      const s = await h.open();
      await s.put('d', { v: 1, value: 1 });
      await s.delete('d');
      await s.delete('never-there');
      check((await s.get('d')) === undefined, 'the record is still there');
    }
  },
  {
    name: 'keys lists only those under a prefix, sorted',
    async run(h) {
      const s = await h.open();
      for (const k of ['mcp.server.b', 'mcp.server.a', 'persona.x', 'mcp.serverish']) await s.put(k, { v: 1, value: k });
      check(same(await s.keys('mcp.server.'), ['mcp.server.a', 'mcp.server.b']), JSON.stringify(await s.keys('mcp.server.')));
    }
  },
  {
    name: 'a record with no whole version, or a value that is not JSON, is refused and not written',
    async run(h) {
      const s = await h.open();
      check(await refused(s.put('v', { v: 0, value: 1 })), 'version 0 was taken');
      check(await refused(s.put('v', { v: 1.5, value: 1 })), 'version 1.5 was taken');
      check(await refused(s.put('v', { v: 1, value: { f: (() => 1) as never } })), 'a function was taken');
      check(await refused(s.put('v', { v: 1, value: Number.NaN })), 'NaN was taken');
      check(await refused(s.put('', { v: 1, value: 1 })), 'an empty key was taken');
      check((await s.get('v')) === undefined, 'a refused record was written');
    }
  },
  {
    name: 'a guarded write or delete happens only if the guard accepts what is stored',
    async run(h) {
      const s = await h.open();
      const v = (n: number) => ({ v: 1, value: { rev: n } });
      const rev = (r: { value: unknown } | undefined) => (r?.value as { rev?: number } | undefined)?.rev ?? 0;
      check(await s.putIf('g', v(1), cur => cur === undefined), 'a first write to an empty key was refused');
      check(!(await s.putIf('g', v(1), cur => cur === undefined)), 'a write meant for an empty key went over a record');
      check(await s.putIf('g', v(3), cur => rev(cur) < 3), 'a newer write was refused');
      check(!(await s.putIf('g', v(2), cur => rev(cur) < 2)), 'an older write went over a newer record');
      check(same(await s.get('g'), v(3)), 'the record is not the newest');
      check(!(await s.deleteIf('g', cur => rev(cur) === 2)), 'a delete meant for another record went through');
      check(same(await s.get('g'), v(3)), 'a refused delete changed the record');
      check(await s.deleteIf('g', cur => rev(cur) === 3), 'a delete of the right record was refused');
      check((await s.get('g')) === undefined, 'the record is still there');
      check(!(await s.deleteIf('g', cur => cur !== undefined)), 'a delete of nothing reported a delete');
    }
  },
  {
    name: 'what was written is there after a reopen',
    async run(h) {
      if (!h.reopen) return;
      const s = await h.open();
      await s.put('kept', { v: 3, value: { kept: true } });
      const again = await h.reopen();
      check(same(await again.get('kept'), { v: 3, value: { kept: true } }), 'the record did not survive the reopen');
    }
  }
];
