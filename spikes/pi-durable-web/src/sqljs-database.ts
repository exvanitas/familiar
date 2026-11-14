// pi-durable's SqliteDatabase facade over sql.js, as an in-page stand-in for an async SQLite behind IPC
// (Tauri's SQL plugin). It logs every call, so the spike can count round trips and see what runs inside
// `transaction()`. `persist` stands in for the file: it gets the whole database after each transaction commits,
// and `transaction()` resolves only after it has, so "COMMIT returned" still means "stored".

type Value = null | number | bigint | string | Uint8Array;

export interface CallLogEntry {
  readonly op: 'exec' | 'run' | 'runCounted' | 'get' | 'all' | 'begin' | 'commit' | 'rollback';
  readonly sql: string;
  readonly inTransaction: boolean;
  readonly transaction?: number;
  /** For commit and rollback: how long the transaction held the database, in ms. */
  readonly heldMs?: number;
}

export interface SqlJsDatabaseOptions {
  readonly persist?: (bytes: Uint8Array) => Promise<void>;
}

function bind(params: Value[]): any[] {
  return params.map((p) => (typeof p === 'bigint' ? Number(p) : p));
}

class Executor {
  constructor(
    protected readonly db: any,
    protected readonly log: CallLogEntry[],
    protected readonly tx: number | undefined
  ) {}

  protected note(op: CallLogEntry['op'], sql: string) {
    this.log.push({ op, sql: sql.replace(/\s+/g, ' ').trim().slice(0, 90), inTransaction: this.tx !== undefined, transaction: this.tx });
  }

  protected check() {}

  async exec(sql: string): Promise<void> {
    this.check();
    this.note('exec', sql);
    this.db.exec(sql);
  }

  async run(sql: string, ...params: Value[]): Promise<void> {
    this.check();
    this.note('run', sql);
    this.db.run(sql, bind(params));
  }

  async runCounted(sql: string, ...params: Value[]): Promise<number> {
    this.check();
    this.note('runCounted', sql);
    this.db.run(sql, bind(params));
    return this.db.getRowsModified();
  }

  async get<T extends object>(sql: string, ...params: Value[]): Promise<T | undefined> {
    this.check();
    this.note('get', sql);
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(bind(params));
      return stmt.step() ? (stmt.getAsObject() as T) : undefined;
    } finally {
      stmt.free();
    }
  }

  async all<T extends object>(sql: string, ...params: Value[]): Promise<T[]> {
    this.check();
    this.note('all', sql);
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(bind(params));
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  }
}

class TransactionHandle extends Executor {
  active = true;
  protected override check() {
    if (!this.active) throw new Error('SQLite transaction handle is no longer active');
  }
}

export class SqlJsDatabase extends Executor {
  readonly calls: CallLogEntry[];
  #tail: Promise<unknown> = Promise.resolve();
  #transactions = 0;
  readonly #persist?: (bytes: Uint8Array) => Promise<void>;

  constructor(db: any, options: SqlJsDatabaseOptions = {}) {
    const log: CallLogEntry[] = [];
    super(db, log, undefined);
    this.calls = log;
    this.#persist = options.persist;
  }

  /** Every top-level call and every transaction runs alone, in call order. */
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  override exec(sql: string) {
    return this.#serial(() => super.exec(sql));
  }
  override run(sql: string, ...params: Value[]) {
    return this.#serial(() => super.run(sql, ...params));
  }
  override runCounted(sql: string, ...params: Value[]) {
    return this.#serial(() => super.runCounted(sql, ...params));
  }
  override get<T extends object>(sql: string, ...params: Value[]) {
    return this.#serial(() => super.get<T>(sql, ...params));
  }
  override all<T extends object>(sql: string, ...params: Value[]) {
    return this.#serial(() => super.all<T>(sql, ...params));
  }

  transaction<T>(callback: (transaction: Executor) => Promise<T>): Promise<T> {
    return this.#serial(async () => {
      const id = ++this.#transactions;
      const handle = new TransactionHandle(this.db, this.calls, id);
      const started = performance.now();
      this.calls.push({ op: 'begin', sql: 'BEGIN IMMEDIATE', inTransaction: true, transaction: id });
      this.db.exec('BEGIN IMMEDIATE');
      let result: T;
      try {
        result = await callback(handle);
      } catch (error) {
        handle.active = false;
        try {
          this.calls.push({ op: 'rollback', sql: 'ROLLBACK', inTransaction: true, transaction: id, heldMs: performance.now() - started });
          this.db.exec('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'SQLite rollback failed');
        }
        throw error;
      }
      handle.active = false;
      this.calls.push({ op: 'commit', sql: 'COMMIT', inTransaction: true, transaction: id, heldMs: performance.now() - started });
      this.db.exec('COMMIT');
      if (this.#persist) await this.#persist(this.db.export());
      return result;
    });
  }

  close(): Promise<void> {
    return this.#serial(async () => {
      this.db.close();
    });
  }
}
