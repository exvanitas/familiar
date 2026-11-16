// Where the trait reader keeps a card's successful reading, by its cache key (the reader's version and
// the card's SHA-256), so an unchanged card is never read twice. In memory for now; persona storage
// (step 11, in pi-durable's IndexedDB store with the persona's other data) gets its own implementation,
// and both run the contract in testing/trait-cache-contract.ts.
import type { TraitReading } from '@familiar/cards';

export interface TraitCache {
  get(key: string): Promise<TraitReading | undefined>;
  set(key: string, reading: TraitReading): Promise<void>;
}

/** Copies in and out, so nothing outside can change what's kept. */
export function memoryTraitCache(): TraitCache {
  const kept = new Map<string, TraitReading>();
  return {
    async get(key) {
      const r = kept.get(key);
      return r === undefined ? undefined : structuredClone(r);
    },
    async set(key, reading) {
      kept.set(key, structuredClone(reading));
    }
  };
}
