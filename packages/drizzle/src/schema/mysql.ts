import { mysqlTable, int, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/mysql-core';

/**
 * Canonical Universal Tuple Table for MySQL.
 * Matches `@zanzojs/drizzle/migrations/mysql.sql`.
 *
 * Identifiers are limited to 255 characters, the same limit ZanzoEngine validates.
 *
 * @param name Table name. Defaults to `zanzo_tuples`.
 */
export function createZanzoTuplesTable(name = 'zanzo_tuples') {
  return mysqlTable(
    name,
    {
      id: int('id').autoincrement().primaryKey(),
      object: varchar('object', { length: 255 }).notNull(),
      relation: varchar('relation', { length: 255 }).notNull(),
      subject: varchar('subject', { length: 255 }).notNull(),
      expiresAt: timestamp('expires_at', { mode: 'date' }),
      createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
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
