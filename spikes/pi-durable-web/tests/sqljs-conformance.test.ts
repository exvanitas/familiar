// Cross-check: pi-durable's storage conformance suite, with Vitest's own expect, over the sql.js facade.
// The page runs the same cases with a small assertion shim. This shows the shim is not hiding failures.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { SqlJsDatabase } from '../src/sqljs-database.ts';

const SQL = await initSqlJs();

registerStorageConformance({ describe, expect, it } as any, 'sql.js facade', async (use) => {
  const storage = await SqliteStorage.open(new SqlJsDatabase(new SQL.Database()) as any);
  try {
    await use(storage as any);
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
});
