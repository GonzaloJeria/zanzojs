import type { Dialect } from './driver';

export interface TableNames {
  /** Relation tuples. @default 'zanzo_tuples' */
  tuples: string;
  /** Change log: one row per write, its id is the revision. @default 'zanzo_changes' */
  changes: string;
  /** Empty table whose CHECK constraints abort a write when a precondition fails. @default 'zanzo_guard' */
  guard: string;
}

export const defaultTables: TableNames = { tuples: 'zanzo_tuples', changes: 'zanzo_changes', guard: 'zanzo_guard' };

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function resolveTables(tables: Partial<TableNames> = {}): TableNames {
  const resolved = { ...defaultTables, ...tables };
  for (const name of Object.values(resolved)) {
    if (!IDENTIFIER.test(name)) throw new Error(`[Zanzo] Invalid table name "${name}".`);
  }
  return resolved;
}

/**
 * Schema for the tuple store. Timestamps are milliseconds since the epoch on SQLite and
 * `timestamptz` on Postgres. Conditions are stored as JSON `{ "name": …, "context": … }`.
 *
 * Indexes:
 * - `(object, relation, subject)` unique: checks walk the graph forward from a resource.
 * - `(subject, relation)`: lookups walk it backwards from a subject.
 */
export function migrationSql(dialect: Dialect, tables: Partial<TableNames> = {}): string {
  const t = resolveTables(tables);
  if (dialect === 'postgres') {
    return `CREATE TABLE IF NOT EXISTS ${t.tuples} (
  id         BIGSERIAL PRIMARY KEY,
  object     TEXT NOT NULL,
  relation   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  condition  JSONB,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ${t.tuples}_unique ON ${t.tuples} (object, relation, subject);
CREATE INDEX IF NOT EXISTS ${t.tuples}_subject ON ${t.tuples} (subject, relation);

CREATE TABLE IF NOT EXISTS ${t.changes} (
  revision   BIGSERIAL PRIMARY KEY,
  operation  TEXT NOT NULL,
  object     TEXT NOT NULL,
  relation   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  condition  JSONB,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${t.guard} (
  kind TEXT NOT NULL,
  CONSTRAINT zanzo_precondition CHECK (kind <> 'p'),
  CONSTRAINT zanzo_exists CHECK (kind <> 'e')
);
`;
  }
  return `CREATE TABLE IF NOT EXISTS ${t.tuples} (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  object     TEXT NOT NULL,
  relation   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  condition  TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS ${t.tuples}_unique ON ${t.tuples} (object, relation, subject);
CREATE INDEX IF NOT EXISTS ${t.tuples}_subject ON ${t.tuples} (subject, relation);

CREATE TABLE IF NOT EXISTS ${t.changes} (
  revision   INTEGER PRIMARY KEY AUTOINCREMENT,
  operation  TEXT NOT NULL,
  object     TEXT NOT NULL,
  relation   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  condition  TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS ${t.guard} (
  kind TEXT NOT NULL,
  CONSTRAINT zanzo_precondition CHECK (kind <> 'p'),
  CONSTRAINT zanzo_exists CHECK (kind <> 'e')
);
`;
}

/** Splits a migration into single statements, for drivers that run one at a time. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
