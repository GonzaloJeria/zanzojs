import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The Universal Zanzo Table (canonical definition, matches migrations/0000_initial.sql)
export { zanzoTuples } from '@zanzojs/drizzle/sqlite';

// Business Domain
export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  workspaceId: text('workspace_id').notNull(),
});
