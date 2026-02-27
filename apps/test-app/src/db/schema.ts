import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// ─── Zanzo Universal Tuple Table ───────────────────────────────────────────
export const zanzoTuples = sqliteTable('zanzo_tuples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  object: text('object').notNull(),
  relation: text('relation').notNull(),
  subject: text('subject').notNull(),
});

// ─── Business Tables ───────────────────────────────────────────────────────
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

export const modules = sqliteTable('modules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

export const workspaceModules = sqliteTable('workspace_modules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull(),
  moduleId: text('module_id').notNull(),
});
