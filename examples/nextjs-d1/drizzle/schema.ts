import { sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

// The Universal Zanzo Table
export const zanzoTuples = sqliteTable('zanzo_tuples', {
  subject: text('subject').notNull(),  // e.g. "User:1"
  relation: text('relation').notNull(), // e.g. "admin"
  object: text('object').notNull(),     // e.g. "Workspace:1"
}, (table: any) => ({
  uniqueKeys: uniqueIndex('idx_zanzo_unique_tuple').on(table.subject, table.relation, table.object),
  subjectRelation: index('idx_zanzo_subject_relation').on(table.subject, table.relation),
  objectRelation: index('idx_zanzo_object_relation').on(table.object, table.relation),
}));

// Business Domain
export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  workspaceId: text('workspace_id').notNull(),
});
