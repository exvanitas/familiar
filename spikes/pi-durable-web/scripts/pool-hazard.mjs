// What happens when pi-durable's `transaction()` is sent as separate calls (BEGIN, statements, COMMIT) to a pool
// of connections, the way a facade over tauri-plugin-sql's execute/select would send them. node:sqlite stands in
// for sqlx: N connections to one file, and each call takes the next connection, as a pool does once concurrent
// calls have made it open more than one. Then the same facade with one connection, for contrast.
// Run with --experimental-strip-types (run-all does) so it can load the TypeScript conformance runner.

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { runConformance } from '../src/conformance.ts';

const here = join(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'pool-hazard-'));
let fileNo = 0;

/** A facade that does what a plain plugin call per statement does: every call goes to the pool on its own. */
function pooledFacade(connections, begin = 'BEGIN IMMEDIATE') {
  const pool = Array.from({ length: connections }, () => null);
  const file = join(dir, `db-${fileNo++}.sqlite`);
  const open = () => {
    const c = new DatabaseSync(file);
    c.exec('PRAGMA busy_timeout = 200; PRAGMA journal_mode = WAL;');
    return c;
  };
  let next = 0;
  const take = () => {
    const i = next++ % pool.length;
    pool[i] ??= open();
    return pool[i];
  };
  const fix = (row) => row && Object.fromEntries(Object.entries(row));
  const call = {
    async exec(sql) {
      take().exec(sql);
    },
    async run(sql, ...params) {
      take().prepare(sql).run(...params);
    },
    async runCounted(sql, ...params) {
      return Number(take().prepare(sql).run(...params).changes);
    },
    async get(sql, ...params) {
      return fix(take().prepare(sql).get(...params));
    },
    async all(sql, ...params) {
      return take().prepare(sql).all(...params).map(fix);
    }
  };
  let tail = Promise.resolve();
  const serial = (op) => {
    const r = tail.then(op);
    tail = r.then(
      () => {},
      () => {}
    );
    return r;
  };
  return {
    exec: (s) => serial(() => call.exec(s)),
    run: (s, ...p) => serial(() => call.run(s, ...p)),
    runCounted: (s, ...p) => serial(() => call.runCounted(s, ...p)),
    get: (s, ...p) => serial(() => call.get(s, ...p)),
    all: (s, ...p) => serial(() => call.all(s, ...p)),
    transaction: (callback) =>
      serial(async () => {
        await call.exec(begin);
        try {
          const result = await callback(call);
          await call.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            await call.exec('ROLLBACK');
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'rollback failed');
          }
          throw error;
        }
      }),
    async close() {
      for (const c of pool) c?.close();
    }
  };
}

// 1. The bare hazard: a write inside a "transaction" that is then rolled back.
async function bare(connections, begin) {
  const db = pooledFacade(connections, begin);
  await db.exec('CREATE TABLE t (v TEXT)');
  let error;
  try {
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t (v) VALUES (?)', 'should vanish');
      throw new Error('callback failed');
    });
  } catch (e) {
    error = e;
  }
  const row = await db.get('SELECT count(*) AS n FROM t');
  await db.close();
  return { connections, begin, rowsAfterRollback: row.n, error: error?.message, inner: error?.errors?.map((e) => e.message) };
}

// 2. pi-durable's own storage conformance cases over the same facade.
async function conformance(connections, begin) {
  const result = await runConformance(async (use) => {
    const storage = await SqliteStorage.open(pooledFacade(connections, begin));
    try {
      await use(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  });
  return {
    connections,
    begin,
    passed: result.passed,
    total: result.total,
    failures: result.failed.slice(0, 4).map((f) => `${f.name}: ${f.error.split('\n')[0].slice(0, 140)}`)
  };
}

const out = {
  bare: [await bare(2, 'BEGIN IMMEDIATE'), await bare(2, 'BEGIN'), await bare(1, 'BEGIN IMMEDIATE')],
  conformance: [await conformance(2, 'BEGIN IMMEDIATE'), await conformance(2, 'BEGIN'), await conformance(1, 'BEGIN IMMEDIATE')]
};
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'pool.json'), JSON.stringify(out, null, 2));
for (const b of out.bare) console.log(`bare, ${b.connections} connection(s), ${b.begin}: rows left after ROLLBACK = ${b.rowsAfterRollback} (${b.error}${b.inner ? ': ' + b.inner.join(' / ') : ''})`);
for (const c of out.conformance) {
  console.log(`pi-durable conformance, ${c.connections} connection(s), ${c.begin}: ${c.passed}/${c.total} passed`);
  for (const f of c.failures) console.log(`   ${f}`);
}
