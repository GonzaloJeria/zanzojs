/**
 * Regression test: Cross-user data leakage via AST cache.
 *
 * The bug: createZanzoAdapter caches the AST per action:resourceType.
 * The AST embeds `targetSubject` (the actor). If Alice requests first,
 * Bob's subsequent request reuses Alice's cached AST — causing the SQL
 * to filter by `subject = 'User:alice'` instead of `subject = 'User:bob'`.
 *
 * The fix: SQL generation always binds the `actor` argument from the current
 * invocation, ignoring `cond.targetSubject` from the cached AST.
 */

import { describe, it, expect } from 'vitest';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText } from 'drizzle-orm/pg-core';
import { mysqlTable, text as mysqlText } from 'drizzle-orm/mysql-core';
import { createZanzoAdapter } from '../src/index.js';
import { ZanzoBuilder, ZanzoEngine } from '@zanzojs/core';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { PgDialect } from 'drizzle-orm/pg-core';
import { MySqlDialect } from 'drizzle-orm/mysql-core';

// ── Shared Schema ────────────────────────────────────────────────────

const schema = new ZanzoBuilder()
  .entity('Document', {
    actions: ['read', 'edit'],
    relations: { viewer: 'User', workspace: 'Workspace' },
    permissions: {
      read: ['viewer', 'workspace.admin'],
      edit: ['workspace.admin'],
    },
  })
  .entity('Workspace', {
    actions: ['manage'],
    relations: { admin: 'User' },
    permissions: { manage: ['admin'] },
  })
  .entity('User', { actions: [], relations: {} })
  .build();

// ── Test: SQLite dialect ─────────────────────────────────────────────

describe('AST Cache Isolation — Cross-User Leakage Regression', () => {

  describe('SQLite dialect', () => {
    const tupleTable = sqliteTable('zanzo_tuples', {
      object: text('object').notNull(),
      relation: text('relation').notNull(),
      subject: text('subject').notNull(),
    });
    const documents = sqliteTable('documents', { id: text('id').primaryKey() });
    const dialect = new SQLiteSyncDialect();

    it('should bind the correct actor per invocation, not the cached first actor', () => {
      const engine = new ZanzoEngine(schema);
      const authz = createZanzoAdapter(engine, tupleTable, { dialect: 'sqlite' });

      // Alice requests first — this populates the AST cache
      const aliceFilter = authz('User:alice', 'read', 'Document', documents.id);
      const aliceQuery = dialect.sqlToQuery(aliceFilter as any);

      // Bob requests second — must use Bob's actor, NOT Alice's
      const bobFilter = authz('User:bob', 'read', 'Document', documents.id);
      const bobQuery = dialect.sqlToQuery(bobFilter as any);

      // Verify Alice's SQL contains 'User:alice' as a bound param
      expect(aliceQuery.params).toContain('User:alice');
      expect(aliceQuery.params).not.toContain('User:bob');

      // Verify Bob's SQL contains 'User:bob' as a bound param
      expect(bobQuery.params).toContain('User:bob');
      expect(bobQuery.params).not.toContain('User:alice');
    });

    it('should isolate actors even with nested permission paths', () => {
      const engine = new ZanzoEngine(schema);
      const authz = createZanzoAdapter(engine, tupleTable, { dialect: 'sqlite' });

      // First call populates the cache for 'edit' on 'Document'
      const aliceEdit = authz('User:alice', 'edit', 'Document', documents.id);
      const aliceQ = dialect.sqlToQuery(aliceEdit as any);

      // Second call with different actor
      const bobEdit = authz('User:bob', 'edit', 'Document', documents.id);
      const bobQ = dialect.sqlToQuery(bobEdit as any);

      expect(aliceQ.params).toContain('User:alice');
      expect(aliceQ.params).not.toContain('User:bob');

      expect(bobQ.params).toContain('User:bob');
      expect(bobQ.params).not.toContain('User:alice');
    });

    it('should produce structurally identical SQL (same relations) but with different actor bindings', () => {
      const engine = new ZanzoEngine(schema);
      const authz = createZanzoAdapter(engine, tupleTable, { dialect: 'sqlite' });

      const aliceFilter = authz('User:alice', 'read', 'Document', documents.id);
      const bobFilter = authz('User:bob', 'read', 'Document', documents.id);

      const aliceQ = dialect.sqlToQuery(aliceFilter as any);
      const bobQ = dialect.sqlToQuery(bobFilter as any);

      // SQL structure must be identical (same relations, same EXISTS shape)
      expect(aliceQ.sql).toBe(bobQ.sql);

      // But the bound params for actor must differ
      const aliceActorParams = aliceQ.params.filter((p: string) => typeof p === 'string' && p.startsWith('User:'));
      const bobActorParams = bobQ.params.filter((p: string) => typeof p === 'string' && p.startsWith('User:'));

      expect(aliceActorParams).toEqual(['User:alice']);
      expect(bobActorParams).toEqual(['User:bob']);
    });
  });

  // ── Test: PostgreSQL dialect ─────────────────────────────────────────

  describe('PostgreSQL dialect', () => {
    const tupleTable = pgTable('zanzo_tuples', {
      object: pgText('object').notNull(),
      relation: pgText('relation').notNull(),
      subject: pgText('subject').notNull(),
    });
    const documents = pgTable('documents', { id: pgText('id').primaryKey() });
    const dialect = new PgDialect();

    it('should bind the correct actor per invocation (postgres)', () => {
      const engine = new ZanzoEngine(schema);
      const authz = createZanzoAdapter(engine, tupleTable, { dialect: 'postgres' });

      const aliceFilter = authz('User:alice', 'read', 'Document', documents.id);
      const aliceQuery = dialect.sqlToQuery(aliceFilter as any);

      const bobFilter = authz('User:bob', 'read', 'Document', documents.id);
      const bobQuery = dialect.sqlToQuery(bobFilter as any);

      expect(aliceQuery.params).toContain('User:alice');
      expect(aliceQuery.params).not.toContain('User:bob');

      expect(bobQuery.params).toContain('User:bob');
      expect(bobQuery.params).not.toContain('User:alice');
    });
  });

  // ── Test: MySQL dialect ──────────────────────────────────────────────

  describe('MySQL dialect', () => {
    const tupleTable = mysqlTable('zanzo_tuples', {
      object: mysqlText('object').notNull(),
      relation: mysqlText('relation').notNull(),
      subject: mysqlText('subject').notNull(),
    });
    const documents = mysqlTable('documents', { id: mysqlText('id').primaryKey() });
    const dialect = new MySqlDialect();

    it('should bind the correct actor per invocation (mysql)', () => {
      const engine = new ZanzoEngine(schema);
      const authz = createZanzoAdapter(engine, tupleTable, { dialect: 'mysql' });

      const aliceFilter = authz('User:alice', 'read', 'Document', documents.id);
      const aliceQuery = dialect.sqlToQuery(aliceFilter as any);

      const bobFilter = authz('User:bob', 'read', 'Document', documents.id);
      const bobQuery = dialect.sqlToQuery(bobFilter as any);

      expect(aliceQuery.params).toContain('User:alice');
      expect(aliceQuery.params).not.toContain('User:bob');

      expect(bobQuery.params).toContain('User:bob');
      expect(bobQuery.params).not.toContain('User:alice');
    });
  });
});
