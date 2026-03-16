import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createZanzoAdapter } from '../src/index.js';
import { ZanzoBuilder, ZanzoEngine } from '@zanzojs/core';

// Simulated Zanzibar Universal Tuple Table
const zanzoTuples = sqliteTable('zanzo_tuples', {
  object: text('object').notNull(),
  relation: text('relation').notNull(),
  subject: text('subject').notNull(),
});

// A standard external Business table.
const invoices = sqliteTable('invoices', {
  id: text('id').primaryKey(),
});

describe('@zanzo/drizzle Adapter Features: Cache & Debug', () => {
  let engine: ZanzoEngine<any>;

  beforeEach(() => {
    const schema = new ZanzoBuilder()
      .entity('Document', {
        actions: ['read', 'write'],
        relations: { owner: 'User' },
        permissions: {
          read: ['owner'],
          write: ['owner']
        }
      })
      .entity('User', { actions: [], relations: {} })
      .build();

    engine = new ZanzoEngine(schema);
  });

  it('should reuse cached AST for subsequent calls with same action and resourceType', () => {
    // Spy on engine.buildDatabaseQuery
    const spy = vi.spyOn(engine, 'buildDatabaseQuery');
    
    const authz = createZanzoAdapter(engine, zanzoTuples);
    
    // Call 1
    authz('User:1', 'read', 'Document', invoices.id);
    expect(spy).toHaveBeenCalledTimes(1);

    // Call 2 - Same action/resourceType (should hit cache)
    authz('User:2', 'read', 'Document', invoices.id);
    expect(spy).toHaveBeenCalledTimes(1);

    // Call 3 - Different action (should recompile once)
    authz('User:1', 'write', 'Document', invoices.id);
    expect(spy).toHaveBeenCalledTimes(2);

    // Call 4 - Repeat call 3 (should hit cache)
    authz('User:3', 'write', 'Document', invoices.id);
    expect(spy).toHaveBeenCalledTimes(2);
    
    spy.mockRestore();
  });

  it('should log debug info when debug: true is enabled', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    
    const authz = createZanzoAdapter(engine, zanzoTuples, { debug: true });
    
    authz('User:1', 'read', 'Document', invoices.id);
    
    expect(debugSpy).toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('[Zanzo Debug]'));
    
    debugSpy.mockRestore();
  });

  it('should NOT log debug info when debug is disabled', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    
    const authz = createZanzoAdapter(engine, zanzoTuples, { debug: false });
    
    authz('User:1', 'read', 'Document', invoices.id);
    
    expect(debugSpy).not.toHaveBeenCalled();
    
    debugSpy.mockRestore();
  });
});
