import { describe, it, expect, beforeEach } from 'vitest';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createZanzoAdapter } from '../src/index.js';
import { ZanzoBuilder, ZanzoEngine } from '@zanzojs/core';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

const zanzoTuples = sqliteTable('zanzo_tuples', {
  object: text('object').notNull(),
  relation: text('relation').notNull(),
  subject: text('subject').notNull(),
});

const invoices = sqliteTable('invoices', {
  id: text('id').primaryKey(),
});

describe('Zanzo Drizzle Security Adapter', () => {
  const dialect = new SQLiteSyncDialect();

  it('should strictly paramerize resourceType preventing Second-Order SQL Injections in AST subqueries', () => {
    const schema = new ZanzoBuilder()
      .entity('Invoice', {
        actions: ['read'],
        relations: { owner: 'User' },
        permissions: { read: ['owner'] }
      })
      .entity('User', { actions: [], relations: {} })
      .build();

    const engine = new ZanzoEngine(schema);
    const authz = createZanzoAdapter(engine, zanzoTuples);

    // Simulate an attacker trying to inject SQL through a crafted resource Type string
    // In strict runtime environments, dynamic types could bypass literal union generics
    const maliciousPayload = "Invoice' OR 1=1; DROP TABLE users; --" as any;

    const result = authz('User:1', 'read', maliciousPayload, invoices.id);
    
    expect(result).toBeDefined();
    
    const { sql: rawSql } = dialect.sqlToQuery(result as any);

    // Ensure the AST safely resolves to an immediate blocker condition (1 = 0)
    // because malicious keys don't exist in the validated schema map array before parsing.
    expect(rawSql).toContain("1 = 0");
    expect(rawSql).not.toContain("DROP TABLE users");
  });

  it('should isolate actor parameters when multiple adapters are created from the same engine', () => {
    const schema = new ZanzoBuilder()
      .entity('Invoice', {
        actions: ['read'],
        relations: { owner: 'User' },
        permissions: { read: ['owner'] }
      })
      .entity('User', { actions: [], relations: {} })
      .build();

    const engine = new ZanzoEngine(schema);
    const authz = createZanzoAdapter(engine, zanzoTuples);

    const resultAlice = authz('User:alice', 'read', 'Invoice', invoices.id);
    const resultBob = authz('User:bob', 'read', 'Invoice', invoices.id);

    const queryAlice = dialect.sqlToQuery(resultAlice as any);
    const queryBob = dialect.sqlToQuery(resultBob as any);

    expect(queryAlice.params).toContain('User:alice');
    expect(queryAlice.params).not.toContain('User:bob');
    expect(queryBob.params).toContain('User:bob');
    expect(queryBob.params).not.toContain('User:alice');
  });

  it('should prevent parameter pollution in the internal AST cache across serial calls', () => {
    const schema = new ZanzoBuilder()
      .entity('Invoice', {
        actions: ['read'],
        relations: { owner: 'User' },
        permissions: { read: ['owner'] }
      })
      .entity('User', { actions: [], relations: {} })
      .build();

    const engine = new ZanzoEngine(schema);
    const authz = createZanzoAdapter(engine, zanzoTuples);

    // Call 1: Alice. This might populate the AST cache.
    authz('User:alice', 'read', 'Invoice', invoices.id);

    // Call 2: Bob. Ensure he doesn't inherit Alice's ID from the cache.
    const resultBob = authz('User:bob', 'read', 'Invoice', invoices.id);
    const queryBob = dialect.sqlToQuery(resultBob as any);

    expect(queryBob.params).toContain('User:bob');
    expect(queryBob.params).not.toContain('User:alice');
  });

  it('should handle malformed actor refs safely by parameterizing them', () => {
    const schema = new ZanzoBuilder()
      .entity('Invoice', {
        actions: ['read'],
        relations: { owner: 'User' },
        permissions: { read: ['owner'] }
      })
      .entity('User', { actions: [], relations: {} })
      .build();

    const engine = new ZanzoEngine(schema);
    const authz = createZanzoAdapter(engine, zanzoTuples);

    const maliciousActor = "User:1' OR '1'='1";
    const result = authz(maliciousActor, 'read', 'Invoice', invoices.id);
    const query = dialect.sqlToQuery(result as any);

    expect(query.params).toContain(maliciousActor);
    // Secure parameters mean the raw SQL doesn't contain the literal malicious string
    expect(query.sql).not.toContain(maliciousActor);
  });
});
