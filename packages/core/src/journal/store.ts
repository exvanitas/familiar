// The journal's store: pi-durable's own IndexedDB store, with every transaction opened strict.
//
// pi-durable opens its transactions without a durability hint, so the browser's default would apply, and
// a strict write is the one the browser flushes to disk before it reports the commit done. The store is
// opened through a wrapped IndexedDB factory that adds `durability: 'strict'` to every transaction the
// database opens, and the open fails unless a probe transaction reports `strict` back. The schema's own
// upgrade transaction is the browser's to open and takes no hint; it runs once, when the database is made.

import { IndexedDbStorage } from '@earendil-works/pi-durable/storage/indexeddb';

/** Thrown when the store can't prove its transactions are strict. Nothing is opened. */
export class NotStrict extends Error {
  constructor(seen: unknown) {
    super(`The journal's store refused to open: a transaction reported durability ${JSON.stringify(seen)}, not "strict".`);
    this.name = 'NotStrict';
  }
}

export interface StrictFactoryOptions {
  /** Sees every transaction the database opens, after the hint is added. For tests. */
  readonly onTransaction?: (transaction: IDBTransaction) => void;
  /** Sees each database connection once it's open. */
  readonly onOpen?: (database: IDBDatabase) => void;
}

/** An IndexedDB factory whose databases open every transaction with `durability: 'strict'`. */
export function strictIndexedDB(factory: IDBFactory, options: StrictFactoryOptions = {}): IDBFactory {
  const strict: Pick<IDBFactory, 'open' | 'deleteDatabase' | 'cmp' | 'databases'> = {
    open(name: string, version?: number) {
      const request = factory.open(name, version);
      // Added before the caller's own listener, so the connection is strict before anyone can use it.
      request.addEventListener('success', () => {
        forceStrict(request.result, options.onTransaction);
        options.onOpen?.(request.result);
      });
      return request;
    },
    deleteDatabase: (name: string) => factory.deleteDatabase(name),
    cmp: (a: unknown, b: unknown) => factory.cmp(a, b),
    databases: () => factory.databases()
  };
  return strict as IDBFactory;
}

function forceStrict(database: IDBDatabase, seen?: (transaction: IDBTransaction) => void): void {
  const open = database.transaction;
  Object.defineProperty(database, 'transaction', {
    configurable: true,
    value(this: IDBDatabase, stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      const transaction = open.call(database, stores, mode, { ...options, durability: 'strict' });
      seen?.(transaction);
      return transaction;
    }
  });
}

/** A probe: a read-only transaction on the open database must say it's strict. */
function assertStrict(database: IDBDatabase): void {
  const names = Array.from(database.objectStoreNames);
  if (names.length === 0) throw new NotStrict('no object stores');
  const probe = database.transaction(names[0]!, 'readonly');
  const durability = (probe as { durability?: unknown }).durability;
  probe.abort();
  if (durability !== 'strict') throw new NotStrict(durability);
}

export interface JournalStore {
  readonly name: string;
  /** pi-durable's storage, for the journal's Harness. */
  readonly storage: IndexedDbStorage;
  /**
   * Drops the connection at once, with no shutdown path: no waiting for operations, no close of the
   * Harness. Transactions already running finish or abort as IndexedDB decides; every later one fails.
   * Tests use it to kill the engine.
   */
  sever(): void;
}

export interface JournalStoreOptions extends StrictFactoryOptions {
  /** The IndexedDB factory: `indexedDB` in a page, a fake one in Node tests. */
  readonly indexedDB: IDBFactory;
}

/** Opens (or makes) the journal's database, strict, or throws `NotStrict` and leaves nothing open. */
export async function openJournalStore(name: string, options: JournalStoreOptions): Promise<JournalStore> {
  let connection: IDBDatabase | undefined;
  const factory = strictIndexedDB(options.indexedDB, {
    ...options,
    onOpen(database) {
      connection = database;
      options.onOpen?.(database);
    }
  });
  const storage = await IndexedDbStorage.open(name, { indexedDB: factory });
  try {
    if (!connection) throw new NotStrict('no connection seen');
    assertStrict(connection);
  } catch (error) {
    connection?.close();
    throw error;
  }
  const database = connection;
  return {
    name,
    storage,
    sever: () => database.close()
  };
}

/** Deletes a journal database. Every connection to it must be closed first. */
export function deleteJournalStore(name: string, indexedDB: IDBFactory): Promise<void> {
  return IndexedDbStorage.delete(name, { indexedDB });
}
