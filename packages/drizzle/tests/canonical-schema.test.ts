import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sqliteTable, text, getTableConfig as getSqliteConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { getTableConfig as getPgConfig } from 'drizzle-orm/pg-core';
import { getTableConfig as getMysqlConfig } from 'drizzle-orm/mysql-core';
import { ZanzoBuilder, ZanzoEngine } from '@zanzojs/core';
import { createZanzoAdapter } from '../src/index.js';
import * as sqliteSchema from '../src/schema/sqlite.js';
import * as pgSchema from '../src/schema/pg.js';
import * as mysqlSchema from '../src/schema/mysql.js';

const readMigration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../migrations/${name}.sql`, import.meta.url)), 'utf8');

/** SQL statements without comments or whitespace differences. */
const statements = (source: string) =>
  source
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

const EXPECTED_COLUMNS = ['id', 'object', 'relation', 'subject', 'expires_at', 'created_at'];
const EXPECTED_INDEXES = {
  idx_zanzo_unique: { unique: true, columns: ['object', 'relation', 'subject'] },
  idx_zanzo_subject_relation: { unique: false, columns: ['subject', 'relation'] },
};

describe('Canonical tuple table definitions', () => {
  const cases = [
    ['sqlite', getSqliteConfig(sqliteSchema.zanzoTuples)],
    ['postgres', getPgConfig(pgSchema.zanzoTuples)],
    ['mysql', getMysqlConfig(mysqlSchema.zanzoTuples)],
  ] as const;

  for (const [dialect, config] of cases) {
    it(`${dialect}: Drizzle table matches the shipped migration`, () => {
      expect(config.name).toBe('zanzo_tuples');
      expect(config.columns.map((c) => c.name)).toEqual(EXPECTED_COLUMNS);

      const indexes = Object.fromEntries(
        config.indexes.map((i) => [i.config.name, { unique: i.config.unique, columns: i.config.columns.map((c: any) => c.name) }]),
      );
      expect(indexes).toEqual(EXPECTED_INDEXES);

      const sql = readMigration(dialect);
      for (const column of EXPECTED_COLUMNS) expect(sql).toMatch(new RegExp(`\\n\\s+${column}\\s`));
      for (const [name, { columns }] of Object.entries(EXPECTED_INDEXES)) {
        expect(sql).toContain(`${name} ON zanzo_tuples (${columns.join(', ')})`);
      }
    });
  }

  it('supports a custom table name', () => {
    expect(getSqliteConfig(sqliteSchema.createZanzoTuplesTable('acl')).name).toBe('acl');
  });

});

describe('expiresAt enforcement end-to-end (SQLite)', () => {
  // node:sqlite ships with Node >= 22.5; skip on older runtimes
  let DatabaseSync: any;
  try {
    DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    DatabaseSync = undefined;
  }

  it.skipIf(!DatabaseSync)('expired tuples never grant access through the adapter', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(readMigration('sqlite'));
    db.exec('CREATE TABLE documents (id TEXT PRIMARY KEY)');
    db.exec("INSERT INTO documents (id) VALUES ('active'), ('expired'), ('permanent')");

    const now = Math.floor(Date.now() / 1000);
    const insert = db.prepare('INSERT INTO zanzo_tuples (object, relation, subject, expires_at) VALUES (?, ?, ?, ?)');
    insert.run('Document:active', 'viewer', 'User:1', now + 3600);
    insert.run('Document:expired', 'viewer', 'User:1', now - 3600);
    insert.run('Document:permanent', 'viewer', 'User:1', null);

    const schema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Document', { actions: ['read'], relations: { viewer: 'User' }, permissions: { read: ['viewer'] } })
      .build();
    const documents = sqliteTable('documents', { id: text('id').primaryKey() });
    const withPermissions = createZanzoAdapter(new ZanzoEngine(schema), sqliteSchema.zanzoTuples, { dialect: 'sqlite' });

    const filter = new SQLiteSyncDialect().sqlToQuery(withPermissions('User:1', 'read', 'Document', documents.id));
    const rows = db.prepare(`SELECT id FROM documents WHERE ${filter.sql} ORDER BY id`).all(...filter.params);

    expect(rows.map((r: any) => r.id)).toEqual(['active', 'permanent']);
  });
});
