// The page headless Chromium runs. It holds one life of a kill scenario on the real IndexedDB, under a
// real Web Lock, or the storage conformance suite. The driver (browser.test.ts) closes the page at the
// kill point and opens it again; counters and the clock's offset live in localStorage, so they survive.

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createStorageConformance } from '@earendil-works/pi-durable/testing';
import { deleteJournalStore, openJournalStore, webLockOwner } from '../../src/index.ts';
import { assertions } from './conformance-shim.ts';
import { scenario, type Counters } from './scenarios.ts';

const params = new URLSearchParams(location.search);
const run = params.get('run') ?? 'run';
const out = (value: unknown) => ((window as any).__familiar = value);

const counters: Counters = {
  get: (k) => Number(localStorage.getItem(`${run}:${k}`) ?? '0'),
  bump(k) {
    const n = this.get(k) + 1;
    localStorage.setItem(`${run}:${k}`, String(n));
    return n;
  },
  set: (k, v) => localStorage.setItem(`${run}:${k}`, String(v)),
  note(k, v) {
    if (v !== undefined) localStorage.setItem(`${run}:note:${k}`, v);
    return localStorage.getItem(`${run}:note:${k}`) ?? undefined;
  }
};

/** Every transaction a journal store opened, with the durability it reported. */
const durabilities: string[] = [];
/** The schema's upgrade transactions, kept apart: the one exception to strict (store.ts). */
const upgrades: string[] = [];
const upgrade = (d: string) => upgrades.push(d);
const seen = () => ({ data: [...new Set(durabilities)], schemaUpgrade: [...new Set(upgrades)] });
const listeners = new Set<() => void>();
const track = (t: IDBTransaction) => {
  durabilities.push(String((t as any).durability));
  for (const l of [...listeners]) l();
};

async function conformance() {
  let n = 0;
  const cases = createStorageConformance({
    assertions,
    withStorage: async (use: (storage: any) => Promise<void>) => {
      const name = `conf-${run}-${n++}`;
      const store = await openJournalStore(name, { indexedDB, onTransaction: track, onUpgrade: upgrade });
      try {
        await use(store.storage);
      } finally {
        await store.storage.close(BACKGROUND_CONTEXT);
        await deleteJournalStore(name, indexedDB);
      }
    }
  } as any);
  const results: { name: string; ok: boolean; error?: string }[] = [];
  for (const c of cases) {
    try {
      await c.run();
      results.push({ name: c.name, ok: true });
    } catch (error: any) {
      results.push({ name: c.name, ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  }
  return { total: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) };
}

async function main() {
  if (params.get('mode') === 'owner') {
    // Holds the journal's owner lock for as long as the page lives.
    await webLockOwner(navigator.locks as any).acquire(run);
    return out({ owned: true });
  }
  if (params.get('mode') === 'conformance') {
    const result = await conformance();
    return out({ done: true, summary: { conformance: result, durabilities: seen(), transactions: durabilities.length, upgrades: upgrades.length } });
  }
  const life = counters.bump('life');
  if (life === 1 && params.has('killAfter')) counters.set('kill-after', Number(params.get('killAfter')));
  const summary = await scenario(params.get('scenario')!).run({
    life,
    counters,
    owner: webLockOwner(navigator.locks as any),
    openStore: (name) => openJournalStore(`${run}-${name}`, { indexedDB, onTransaction: track, onUpgrade: upgrade }),
    onTransaction: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    // The driver closes the page here: no shutdown path runs.
    ready: () => out({ ready: true, life })
  });
  if (summary) out({ done: true, life, summary: { ...summary, durabilities: seen() } });
}

main().catch((error) => out({ done: true, failed: String(error?.stack ?? error) }));
