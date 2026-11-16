// The settings store's contract, against memory and IndexedDB (fake-indexeddb, every transaction strict).
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { memorySettingsStore, openSettingsStore } from '../src/settings/store.ts';
import { settingsStoreContract } from '../src/testing/index.ts';

describe('the settings store contract, in memory', () => {
  for (const c of settingsStoreContract) it(c.name, () => c.run({ open: async () => memorySettingsStore() }));
});

describe('the settings store contract, on IndexedDB', () => {
  let n = 0;
  const harness = () => {
    const factory = new IDBFactory() as unknown as globalThis.IDBFactory;
    const name = `settings-${++n}`;
    return { open: () => openSettingsStore(factory, name), reopen: () => openSettingsStore(factory, name) };
  };
  for (const c of settingsStoreContract) it(c.name, () => c.run(harness()));

  it('opens every transaction strict', async () => {
    const factory = new IDBFactory() as unknown as globalThis.IDBFactory;
    const seen: string[] = [];
    const open = factory.open.bind(factory);
    // Watch the transactions the store's connection opens.
    (factory as { open: typeof factory.open }).open = (name: string, version?: number) => {
      const req = open(name, version);
      req.addEventListener('success', () => {
        const db = req.result;
        const tx = db.transaction.bind(db);
        Object.defineProperty(db, 'transaction', { configurable: true, value: (s: string, m: IDBTransactionMode, o?: IDBTransactionOptions) => { seen.push(o?.durability ?? 'default'); return tx(s, m, o); } });
      });
      return req;
    };
    const s = await openSettingsStore(factory, 'strict');
    await s.put('k', { v: 1, value: 1 });
    await s.get('k');
    await s.keys('');
    await s.delete('k');
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.every(d => d === 'strict')).toBe(true);
  });
});
