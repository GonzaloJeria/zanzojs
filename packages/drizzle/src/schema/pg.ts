import { pgTable, serial, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Canonical Universal Tuple Table for PostgreSQL.
 * Matches `@zanzojs/drizzle/migrations/postgres.sql`.
 *
 * `expiresAt` is read back as `Date`, so rows can be passed straight to
 * `engine.load()` and expiration is enforced by the adapter.
 *
 * @param name Table name. Defaults to `zanzo_tuples`.
 */
export function createZanzoTuplesTable(name = 'zanzo_tuples') {
  return pgTable(
    name,
    {
      id: serial('id').primaryKey(),
      object: text('object').notNull(),
      relation: text('relation').notNull(),
      subject: text('subject').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
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
