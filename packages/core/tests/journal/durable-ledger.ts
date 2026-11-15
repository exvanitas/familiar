// The caps ledger in the journal's store, for the caps tests: a Harness on a strict fake IndexedDB, with
// the same `all` and `reservations` views the memory store has. They are read back from the store after
// every update, never kept on the side.

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { emptyLedger, journalUsageStore, type JournalStore, type Ledger, type UsageStore } from '../../src/index.ts';
import { nodeWorld, type NodeWorld } from './node-env.ts';

export interface LedgerInstance {
  readonly store: JournalStore;
  readonly harness: any;
  readonly usage: UsageStore;
}

/** Opens a Harness on the world's ledger database, as a restarted app would. */
export async function openLedger(world: NodeWorld, name = 'ledger'): Promise<LedgerInstance> {
  const store = await world.open(name);
  const harness = await Harness.open(store.storage, { models: createModels(), registry: createRegistry(), identity: { attribution: null } } as any, BACKGROUND_CONTEXT);
  return { store, harness, usage: journalUsageStore(harness) };
}

/** A UsageStore in the journal's store, opened on first use. `pause` runs before every call. */
export function durableUsageStore(pause: () => Promise<void> = async () => {}, world: NodeWorld = nodeWorld()): UsageStore & { readonly all: Ledger['records']; readonly reservations: Ledger['open']; readonly extensions: Ledger['extensions']; readonly folded: Ledger['turns'] } {
  let mirror = emptyLedger();
  let opened: Promise<LedgerInstance> | undefined;
  const instance = () => (opened ??= openLedger(world));
  return {
    get all() {
      return mirror.records;
    },
    get reservations() {
      return mirror.open;
    },
    get extensions() {
      return mirror.extensions;
    },
    get folded() {
      return mirror.turns;
    },
    async update(change) {
      await pause();
      const { usage } = await instance();
      const out = await usage.update(change);
      mirror = await usage.read();
      return out;
    },
    async read() {
      await pause();
      return (await instance()).usage.read();
    }
  };
}
