// One owner per journal database. pi-durable's IndexedDB store says one owner must hold the database at a
// time, and the caps ledger's atomicity rests on it (ledger.ts). In a page that's a Web Lock held for the
// journal's whole life: a second instance, in this page or another, waits for it, and the browser releases
// it when the page goes away, a reload or a kill included.

export interface OwnerLock {
  /** Resolves once this caller owns `name`. Holds it until `release`, or until the page goes away. */
  acquire(name: string): Promise<{ release(): void }>;
}

/** The Web Locks API, as a page has it (`navigator.locks`). */
export interface WebLocks {
  request(name: string, options: { mode: 'exclusive' }, callback: () => Promise<void>): Promise<unknown>;
}

export function webLockOwner(locks: WebLocks): OwnerLock {
  return {
    acquire(name) {
      return new Promise((resolve, reject) => {
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        locks
          .request(`familiar.journal:${name}`, { mode: 'exclusive' }, async () => {
            resolve({ release });
            await held;
          })
          .catch(reject);
      });
    }
  };
}
