import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Canonical Universal Tuple Table for SQLite and Cloudflare D1.
 * Matches `@zanzojs/drizzle/migrations/sqlite.sql`.
 *
 * Timestamps are stored as unix seconds and read back as `Date`, so rows can be
 * passed straight to `engine.load()` and `expiresAt` is enforced by the adapter.
 *
 * @param name Table name. Defaults to `zanzo_tuples`.
 */
export function createZanzoTuplesTable(name = 'zanzo_tuples') {
  return sqliteTable(
    name,
    {
      id: integer('id').primaryKey({ autoIncrement: true }),
      object: text('object').notNull(),
      relation: text('relation').notNull(),
      subject: text('subject').notNull(),
      expiresAt: integer('expires_at', { mode: 'timestamp' }),
      createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    },
    (table) => ({
      // Serves the adapter's EXISTS check (object, relation, subject) and prevents duplicates
      uniqueTuple: uniqueIndex('idx_zanzo_unique').on(table.object, table.relation, table.subject),
      // Serves loading an actor's tuples for engine.load() and snapshots
      subjectRelation: index('idx_zanzo_subject_relation').on(table.subject, table.relation),
    }),
  );
}

export const zanzoTuples = createZanzoTuplesTable();
