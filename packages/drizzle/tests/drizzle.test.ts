import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createZanzoAdapter } from '../src/index.js';
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

  it('should translate direct conditions to EXISTS lookups with secure parameterization', () => {
    const authz = createZanzoAdapter(engine, zanzoTuples);
    
    // Generates the AST -> maps to tupleTable EXISTS clause via secure parameters.
    const result = authz('User:1', 'pay', 'Invoice', invoices.id); 
    
    expect(result).toBeDefined();
    const { sql: rawSql, params } = dialect.sqlToQuery(result as any);
    
    // Check it bound the right business column dynamically
    // We now expect CONCAT(?, ?, col) because of secure parameters
    expect(rawSql).toContain(`"zanzo_tuples"."object" = CONCAT(?, ?, "invoices"."id")`);
    
    // Check parameters
    expect(params).toContain('Invoice');
    expect(params).toContain(':');
    expect(params).toContain('owner');
    expect(params).toContain('User:1');
  });

  it('should support SQLite dialect with || concatenation operator', () => {
    const authz = createZanzoAdapter(engine, zanzoTuples, { dialect: 'sqlite' });
    
    const result = authz('User:1', 'pay', 'Invoice', invoices.id);
    const { sql: rawSql, params } = dialect.sqlToQuery(result as any);
    
    // SQLite dialect uses || operator
    expect(rawSql).toContain(`"zanzo_tuples"."object" = ? || ? || "invoices"."id"`);
    expect(params).toContain('Invoice');
    expect(params).toContain(':');
  });

  it('should evaluate nested conditions seamlessly mapping to Tuple Expansion strings (e.g. team.member) for O(1) EXISTS resolution', () => {
    const authz = createZanzoAdapter(engine, zanzoTuples);
    
    // Resolves to owner (direct) OR team.member (nested). 
    const result = authz('User:99', 'read', 'Invoice', invoices.id);

    expect(result).toBeDefined();
    const { sql: rawSql, params } = dialect.sqlToQuery(result as any);
    
    // Expecting 1 optimized query with IN clause
    expect(rawSql).toContain('EXISTS');
    expect(rawSql).toContain(' IN '); // The optimized IN operator for multiple relations
    expect(params).toContain('owner');
    expect(params).toContain('team.member');
    expect(params).toContain('User:99'); 
  });

  it('should apply debug mode and output logs without crashing', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const authz = createZanzoAdapter(engine, zanzoTuples, { debug: true });
    
    authz('User:1', 'read', 'Invoice', invoices.id);
    
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('should respect custom dialect settings (mysql)', () => {
    const authz = createZanzoAdapter(engine, zanzoTuples, { dialect: 'mysql' });
    const result = authz('User:1', 'pay', 'Invoice', invoices.id);
    const { sql: rawSql } = dialect.sqlToQuery(result as any);
    
    // MySQL uses CONCAT (default in the adapter logic for mysql/postgres)
    expect(rawSql).toContain('CONCAT');
    expect(rawSql).not.toContain('||');
  });

  it('should throw AST_OVERFLOW if the engine returns too many conditions', () => {
    let megaBuilder = new ZanzoBuilder();
    const relations: string[] = [];
    for (let i = 0; i < 110; i++) {
      megaBuilder = megaBuilder.entity(`Rel${i}` as any, { actions: [], relations: {} }) as any;
      relations.push(`rel${i}`);
    }
    megaBuilder = megaBuilder.entity('Large', {
      actions: ['read'],
      relations: Object.fromEntries(relations.map(r => [r, 'User'])),
      permissions: { read: relations as any }
    }) as any;
    
    const largeEngine = new ZanzoEngine(megaBuilder.build());
    const authz = createZanzoAdapter(largeEngine, zanzoTuples);

    expect(() => authz('User:1', 'read' as any, 'Large' as any, invoices.id)).toThrow('[Zanzo] Security Exception');
  });
});
