// A small key-value store for settings: saved MCP server setups now, personas and the rest of Settings
// later (step 11). Each record carries its schema version, so a reader knows what it reads and can
// migrate. Values are JSON, copied in and out, so nothing outside can change what's kept.
//
// Two implementations run one contract (src/testing/settings-contract.ts): in memory, and IndexedDB with
// every transaction strict, in the app's webview (fake-indexeddb in Node tests).

import type { JsonValue } from '../model/port.ts';
import { strictIndexedDB } from '../journal/store.ts';

export interface Stored {
  /** The record's schema version: a whole number from 1. */
  readonly v: number;
  readonly value: JsonValue;
}

export interface SettingsStore {
  get(key: string): Promise<Stored | undefined>;
  /** Writes the record. Resolves once it's durable. */
  put(key: string, record: Stored): Promise<void>;
  delete(key: string): Promise<void>;
  /** The keys that start with `prefix`, sorted. */
  keys(prefix: string): Promise<string[]>;
}

export const MAX_KEY = 256;

/** Checks a key and a record, and returns a JSON copy of the record. */
function checked(key: string, record?: Stored): Stored | undefined {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY) throw new Error(`A settings key is 1 to ${MAX_KEY} characters.`);
  if (record === undefined) return undefined;
  if (!Number.isInteger(record.v) || record.v < 1) throw new Error('A settings record needs a whole version from 1.');
  const text = JSON.stringify(record.value, (_k, v: unknown) => {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('A settings value must be plain JSON.');
    if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') throw new Error('A settings value must be plain JSON.');
    return v;
  });
  if (text === undefined) throw new Error('A settings value must be plain JSON.');
  return { v: record.v, value: JSON.parse(text) as JsonValue };
}

const copy = (r: Stored): Stored => ({ v: r.v, value: JSON.parse(JSON.stringify(r.value)) as JsonValue });

export function memorySettingsStore(): SettingsStore {
  const rows = new Map<string, Stored>();
  return {
    async get(key) {
      checked(key);
      const r = rows.get(key);
      return r && copy(r);
    },
    async put(key, record) {
      rows.set(key, checked(key, record)!);
    },
    async delete(key) {
      checked(key);
      rows.delete(key);
    },
    async keys(prefix) {
      return [...rows.keys()].filter(k => k.startsWith(prefix)).sort();
    }
  };
}

const STORE = 'settings';

export interface IndexedSettingsStore extends SettingsStore {
  close(): void;
}

/** The settings store on IndexedDB, every transaction strict. */
export async function openSettingsStore(factory: IDBFactory, name = 'familiar-settings'): Promise<IndexedSettingsStore> {
  const idb = strictIndexedDB(factory);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest | undefined): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = f(tx.objectStore(STORE));
      // A write counts once its transaction completes, which a strict one does only once it's on disk.
      tx.oncomplete = () => resolve(req?.result as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('The settings transaction was aborted.'));
    });
  return {
    async get(key) {
      checked(key);
      const r = await run<Stored | undefined>('readonly', s => s.get(key));
      return r === undefined ? undefined : copy(r);
    },
    async put(key, record) {
      const r = checked(key, record)!;
      await run('readwrite', s => s.put(r, key));
    },
    async delete(key) {
      checked(key);
      await run('readwrite', s => s.delete(key));
    },
    async keys(prefix) {
      const all = await run<IDBValidKey[]>('readonly', s => s.getAllKeys());
      return all.map(String).filter(k => k.startsWith(prefix)).sort();
    },
    close: () => db.close()
  };
}
