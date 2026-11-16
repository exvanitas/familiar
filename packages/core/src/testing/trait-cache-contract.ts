// The trait cache's contract. The in-memory cache runs it now; persona storage's cache runs it when it
// comes (step 11). Plain async checks, so any test runner can drive them.
import type { TraitReading } from '@familiar/cards';
import type { TraitCache } from '../traits/cache.ts';

export interface TraitCacheCase {
  readonly name: string;
  run(make: () => Promise<TraitCache>): Promise<void>;
}

export const CONTRACT_READING: TraitReading = {
  sociability: 'reserved', closeness: 'clingy', lively: 'night', interests: ['moths', 'folk music'], evidence: { sociability: 'says little' }
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export const traitCacheContract: readonly TraitCacheCase[] = [
  {
    name: 'an unknown key has nothing',
    async run(make) {
      const cache = await make();
      check((await cache.get('traits-v1:none')) === undefined, 'expected undefined for an unknown key');
    }
  },
  {
    name: 'what was set comes back the same',
    async run(make) {
      const cache = await make();
      await cache.set('traits-v1:a', CONTRACT_READING);
      check(same(await cache.get('traits-v1:a'), CONTRACT_READING), 'the reading came back changed');
    }
  },
  {
    name: 'a second set replaces the first; other keys are untouched',
    async run(make) {
      const cache = await make();
      const other: TraitReading = { ...CONTRACT_READING, sociability: 'outgoing', evidence: {} };
      await cache.set('traits-v1:a', CONTRACT_READING);
      await cache.set('traits-v1:b', CONTRACT_READING);
      await cache.set('traits-v1:a', other);
      check(same(await cache.get('traits-v1:a'), other), 'the second set did not replace the first');
      check(same(await cache.get('traits-v1:b'), CONTRACT_READING), 'another key changed');
    }
  },
  {
    name: 'keys differ by the reader version',
    async run(make) {
      const cache = await make();
      await cache.set('traits-v1:same-hash', CONTRACT_READING);
      check((await cache.get('traits-v2:same-hash')) === undefined, 'a new reader version found the old reading');
    }
  },
  {
    name: 'changing a reading after set, or after get, changes nothing kept',
    async run(make) {
      const cache = await make();
      const mine = structuredClone(CONTRACT_READING) as unknown as { interests: string[]; sociability: string };
      await cache.set('traits-v1:a', mine as unknown as TraitReading);
      mine.interests.push('changed');
      mine.sociability = 'outgoing';
      const got = (await cache.get('traits-v1:a')) as unknown as { interests: string[] };
      got.interests.push('changed again');
      check(same(await cache.get('traits-v1:a'), CONTRACT_READING), 'a change outside the cache reached what it keeps');
    }
  }
];
