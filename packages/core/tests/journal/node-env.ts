// The Node side of the kill tests: a fake IndexedDB that outlives a life, an owner lock in memory, and
// counters in memory. A kill drops the store's connection at once and abandons the engine: no close.

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openJournalStore, type JournalStore, type OwnerLock } from '../../src/index.ts';
import type { Counters, Env, Scenario, Summary } from './scenarios.ts';

// pi-durable's store reads key ranges from the global, as a page has them.
(globalThis as any).IDBKeyRange ??= IDBKeyRange;

export function memoryCounters(): Counters {
  const n = new Map<string, number>();
  const notes = new Map<string, string>();
  return {
    get: (k) => n.get(k) ?? 0,
    bump: (k) => {
      n.set(k, (n.get(k) ?? 0) + 1);
      return n.get(k)!;
    },
    set: (k, v) => void n.set(k, v),
    note: (k, v) => {
      if (v !== undefined) notes.set(k, v);
      return notes.get(k);
    }
  };
}

/** An exclusive lock per name, in memory. A second acquire waits for the first release. */
export function memoryOwner(): OwnerLock {
  const tails = new Map<string, Promise<void>>();
  return {
    async acquire(name) {
      const before = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      tails.set(name, before.then(() => mine));
      await before;
      return { release };
    }
  };
}

export interface NodeWorld {
  readonly factory: IDBFactory;
  readonly owner: OwnerLock;
  readonly counters: Counters;
  readonly transactions: IDBTransaction[];
  open(name: string): Promise<JournalStore>;
}

export function nodeWorld(): NodeWorld {
  const factory = new IDBFactory();
  const transactions: IDBTransaction[] = [];
  return {
    factory,
    owner: memoryOwner(),
    counters: memoryCounters(),
    transactions,
    open: (name) => openJournalStore(name, { indexedDB: factory as unknown as globalThis.IDBFactory, onTransaction: (t) => transactions.push(t) })
  };
}

/** Life 1 until it's ready, a kill, then life 2 on the same store. */
export async function killAndResume(s: Scenario, world: NodeWorld = nodeWorld()): Promise<Summary> {
  let kill: (() => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    const env: Env = {
      life: 1,
      counters: world.counters,
      owner: world.owner,
      openStore: world.open,
      ready: (k) => {
        kill = k;
        resolve();
      }
    };
    s.run(env).then(() => resolve(), reject);
  });
  await ready;
  if (!kill) throw new Error(`${s.name}: life 1 ended without reaching its kill point`);
  kill();
  const summary = await s.run({ life: 2, counters: world.counters, owner: world.owner, openStore: world.open, ready: () => {} });
  if (!summary) throw new Error(`${s.name}: life 2 gave no summary`);
  return summary;
}
