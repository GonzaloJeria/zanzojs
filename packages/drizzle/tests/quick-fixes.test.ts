import { describe, it, expect, vi } from 'vitest';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { createZanzoAdapter } from '../src/index.js';
import { ZanzoBuilder, ZanzoEngine } from '@zanzojs/core';

const tuplesWithExpiry = sqliteTable('zanzo_tuples', {
  object: text('object').notNull(),
  relation: text('relation').notNull(),
  subject: text('subject').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
});

const documents = sqliteTable('documents', { id: text('id').primaryKey() });

const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Workspace', { actions: [], relations: { admin: 'User' } })
  .entity('Document', {
    actions: ['read'],
    relations: { owner: 'User', workspace: 'Workspace' },
    permissions: { read: ['owner', 'workspace.admin'] },
  })
  .build();

describe('Drizzle adapter quick fixes', () => {
  it('filters expired tuples when the table has an expiresAt column', () => {
    const adapter = createZanzoAdapter(new ZanzoEngine(schema), tuplesWithExpiry, {
      dialect: 'sqlite',
      warnOnNestedConditions: false,
    });
    const query = new SQLiteSyncDialect().sqlToQuery(adapter('User:1', 'read', 'Document', documents.id));

    expect(query.sql).toContain('"expires_at" IS NULL OR');
    expect(query.sql).toMatch(/"expires_at" > \?/);
    // The current time is bound through the column mapping (unix seconds for timestamp mode)
    expect(query.params.some((p) => typeof p === 'number')).toBe(true);
  });

  it('warns about each nested path only once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = createZanzoAdapter(new ZanzoEngine(schema), tuplesWithExpiry, {
      dialect: 'sqlite',
      warnOnNestedConditions: true,
    });

    adapter('User:1', 'read', 'Document', documents.id);
    adapter('User:2', 'read', 'Document', documents.id);

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
