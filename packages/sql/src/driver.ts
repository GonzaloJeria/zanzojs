/** A SQL statement with `?` placeholders. Dialects rewrite placeholders as needed. */
export interface Statement {
  sql: string;
  params: readonly unknown[];
}

export type Row = Record<string, unknown>;

export type Dialect = 'sqlite' | 'postgres';

/**
 * The only thing Zanzo needs from a database. Implement it for any client, or use one of
 * the bundled factories: `d1Driver`, `sqliteDriver`, `libsqlDriver`, `pgDriver`, `pgliteDriver`.
 */
export interface SqlDriver {
  dialect: Dialect;
  /**
   * Largest number of bound parameters per statement. Cloudflare D1 allows 100.
   * @default 100 for sqlite, 10000 for postgres
   */
  maxParams?: number;
  /** Runs read statements, ideally in a single round trip. Results are in statement order. */
  query(statements: Statement[]): Promise<Row[][]>;
  /** Runs statements atomically: all of them apply or none does. Results are in statement order. */
  transaction(statements: Statement[]): Promise<Row[][]>;
}

/** Rewrites `?` placeholders as `$1, $2, …`. Zanzo never emits a literal `?`. */
export function toPostgres(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ─── Cloudflare D1 ──────────────────────────────────────────────────

interface D1Like {
  prepare(sql: string): { bind(...values: unknown[]): unknown };
  batch(statements: unknown[]): Promise<{ results?: Row[] }[]>;
}

/**
 * Cloudflare D1. `batch` runs statements in one round trip and in a transaction, so reads
 * of a whole graph level and writes both cost a single request.
 */
export function d1Driver(db: D1Like): SqlDriver {
  const run = async (statements: Statement[]) => {
    if (statements.length === 0) return [];
    const results = await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)));
    return results.map((r) => r.results ?? []);
  };
  return { dialect: 'sqlite', maxParams: 100, query: run, transaction: run };
}

// ─── Synchronous SQLite: node:sqlite, better-sqlite3, bun:sqlite ────

interface SyncSqliteLike {
  prepare(sql: string): { all(...params: any[]): unknown[] };
  exec(sql: string): unknown;
}

/** `node:sqlite` (`DatabaseSync`), `better-sqlite3` and `bun:sqlite`. */
export function sqliteDriver(db: SyncSqliteLike): SqlDriver {
  const cache = new Map<string, { all(...params: any[]): unknown[] }>();
  const prepared = (sql: string) => {
    let statement = cache.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      if (cache.size > 500) cache.clear();
      cache.set(sql, statement);
    }
    return statement;
  };
  const runAll = (statements: Statement[]) => statements.map((s) => prepared(s.sql).all(...s.params) as Row[]);
  return {
    dialect: 'sqlite',
    maxParams: 999,
    query: async (statements) => runAll(statements),
    async transaction(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = runAll(statements);
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

// ─── libSQL / Turso ─────────────────────────────────────────────────

interface LibsqlLike {
  batch(statements: { sql: string; args: any[] }[], mode?: 'write' | 'read' | 'deferred'): Promise<{ rows: unknown[] }[]>;
}

/** `@libsql/client` (Turso). Reads and writes are each one batch request. */
export function libsqlDriver(client: LibsqlLike): SqlDriver {
  const run = (mode: 'read' | 'write') => async (statements: Statement[]) => {
    if (statements.length === 0) return [];
    const results = await client.batch(statements.map((s) => ({ sql: s.sql, args: [...s.params] })), mode);
    return results.map((r) => r.rows.map((row) => ({ ...(row as Row) })));
  };
  return { dialect: 'sqlite', maxParams: 999, query: run('read'), transaction: run('write') };
}

// ─── Postgres ───────────────────────────────────────────────────────

interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}
interface PgPoolLike extends PgQueryable {
  connect?(): Promise<PgQueryable & { release(): void }>;
}

/**
 * `pg` (node-postgres) `Pool` or `Client`, and any client with `query(text, values)`.
 * Reads of one graph level are sent as a single `UNION ALL` statement.
 */
export function pgDriver(pool: PgPoolLike): SqlDriver {
  const runOn = async (client: PgQueryable, statements: Statement[]) => {
    const results: Row[][] = [];
    for (const s of statements) results.push((await client.query(toPostgres(s.sql), [...s.params])).rows);
    return results;
  };
  return {
    dialect: 'postgres',
    maxParams: 10000,
    query: (statements) => runOn(pool, statements),
    async transaction(statements) {
      const client = pool.connect ? await pool.connect() : pool;
      try {
        await client.query('BEGIN');
        const results = await runOn(client, statements);
        await client.query('COMMIT');
        return results;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        if ('release' in client && typeof client.release === 'function') client.release();
      }
    },
  };
}

interface PgliteLike extends PgQueryable {
  transaction<T>(fn: (tx: PgQueryable) => Promise<T>): Promise<T>;
}

/** `@electric-sql/pglite`: Postgres in WebAssembly, handy for tests and local development. */
export function pgliteDriver(db: PgliteLike): SqlDriver {
  const runOn = async (client: PgQueryable, statements: Statement[]) => {
    const results: Row[][] = [];
    for (const s of statements) results.push((await client.query(toPostgres(s.sql), [...s.params])).rows);
    return results;
  };
  return {
    dialect: 'postgres',
    maxParams: 10000,
    query: (statements) => runOn(db, statements),
    transaction: (statements) => db.transaction((tx) => runOn(tx, statements)),
  };
}
