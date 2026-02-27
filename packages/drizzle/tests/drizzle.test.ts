import { describe, it, expect, beforeEach } from 'vitest';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createZanzoAdapter } from '../src/index';
import { ZanzoBuilder, ZanzoEngine, RelationTuple } from '@zanzojs/core';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

// Simulated Zanzibar Universal Tuple Table
const zanzoTuples = sqliteTable('zanzo_tuples', {
  object: text('object').notNull(),
  relation: text('relation').notNull(),
  subject: text('subject').notNull(),
});

// A standard external Business table.
const invoices = sqliteTable('invoices', {
  id: text('id').primaryKey(),
  amount: text('amount'),
});

describe('@zanzo/drizzle Zero-Config Adapter', () => {

  let engine: ZanzoEngine<any>;
  const dialect = new SQLiteSyncDialect();

  beforeEach(() => {
    // Setup generic Zanzibar Schema context
    const schema = new ZanzoBuilder()
      .entity('Invoice', {
        actions: ['read', 'pay'],
        relations: { owner: 'User', team: 'Group' },
        permissions: {
          read: ['owner', 'team.member'],
          pay: ['owner']
        }
      })
      .entity('User', { actions: [], relations: {} })
      .entity('Group', { actions: [], relations: { member: 'User' } })
      .build();

    engine = new ZanzoEngine(schema);
  });

  it('should return 1 = 0 SQL blocker when access is totally denied', () => {
    const authz = createZanzoAdapter(engine, zanzoTuples);
    // User asking for non-exist permissions returns null AST
    const result = authz('User:1', 'read', 'User', invoices.id); 
    
    const { sql: rawSql } = dialect.sqlToQuery(result as any);
    expect(rawSql).toContain('1 = 0');
  });

  it('should translate direct conditions to EXISTS lookups mapped directly to the universal tuples table', () => {
    const authz = createZanzoAdapter(engine, zanzoTuples);
    
    // Generates the AST -> maps to tupleTable EXISTS clause via string concatenation.
    const result = authz('User:1', 'pay', 'Invoice', invoices.id); 
    
    expect(result).toBeDefined();
    // Drizzle Dialect builder extracts SQL parameters to prevent SQL Injection
    const { sql: rawSql, params } = dialect.sqlToQuery(result as any);
    
    // Check it bound the right business column dynamically
    expect(rawSql).toContain(`"zanzo_tuples"."object" = ? || ':' || "invoices"."id"`);
    // Check it binds the relation identifier efficiently
    expect(params).toContain('owner');
    // Check it filters on target subject
    expect(params).toContain('User:1');
  });

  it('should evaluate nested conditions seamlessly mapping to Tuple Expansion strings (e.g. team.member) for O(1) EXISTS resolution', () => {
    const authz = createZanzoAdapter(engine, zanzoTuples);
    
    // Resolves to owner (direct) OR team.member (nested). 
    const result = authz('User:99', 'read', 'Invoice', invoices.id);

    expect(result).toBeDefined();
    const { sql: rawSql, params } = dialect.sqlToQuery(result as any);
    
    // Expecting 2 queries chained via OR implicitly by the ReBAC engine parsing.
    expect(rawSql).toContain('EXISTS');
    expect(rawSql).toContain(' or '); // The SQL operator wrapping both
    expect(params).toContain('owner');
    expect(params).toContain('team.member');
    expect(params).toContain('User:99'); 
  });
});
