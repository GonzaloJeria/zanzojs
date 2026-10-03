import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { sqliteTable, text, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { ZanzoEngine, materializeDerivedTuples } from '@zanzojs/core';
import { createZanzoAdapter } from '../src/index.js';
import { zanzoTuples } from '../src/schema/sqlite.js';
import { defineConformanceSuite } from '../../core/conformance/runner';
import { toLegacySchema } from '../../core/conformance/legacy';
import { typeOf } from '../../core/conformance/model';

let DatabaseSync: any;
try {
  DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync;
} catch {
  DatabaseSync = undefined;
}

const migration = readFileSync(fileURLToPath(new URL('../migrations/sqlite.sql', import.meta.url)), 'utf8');
const dialect = new SQLiteSyncDialect();

if (!DatabaseSync) {
  describe.skip('conformance: Drizzle adapter (requires node:sqlite, Node >= 22.5)', () => {
    it('skipped', () => {});
  });
} else {
  /**
   * The documented write path: every tuple is inserted together with the derived tuples
   * produced by materializeDerivedTuples, in the order the case lists them.
   */
  defineConformanceSuite(
    {
      name: 'Drizzle adapter + materializeDerivedTuples (current, SQLite)',
      async create(schema, tuples) {
        const translated = toLegacySchema(schema);
        if ('unsupported' in translated) return translated;

        const db = new DatabaseSync(':memory:');
        db.exec(migration);
        const insert = db.prepare(
          'INSERT OR IGNORE INTO zanzo_tuples (object, relation, subject, expires_at) VALUES (?, ?, ?, ?)',
        );
        const children = db.prepare('SELECT object FROM zanzo_tuples WHERE subject = ? AND relation = ?');

        for (const tuple of tuples) {
          const expiresAt = tuple.expiresAt === undefined ? null : Math.floor(tuple.expiresAt / 1000);
          insert.run(tuple.object, tuple.relation, tuple.subject, expiresAt);
          const derived = await materializeDerivedTuples({
            schema: translated.schema,
            newTuple: { object: tuple.object, relation: tuple.relation, subject: tuple.subject },
            fetchChildren: (parent, relation) => children.all(parent, relation).map((row: any) => row.object),
          });
          for (const d of derived) insert.run(d.object, d.relation, d.subject, null);
        }

        // One business table per entity type holding the ids seen in the tuples
        const tables = new Map<string, ReturnType<typeof sqliteTable>>();
        const tableFor = (type: string) => {
          let table = tables.get(type);
          if (!table) {
            db.exec(`CREATE TABLE IF NOT EXISTS "res_${type}" (id TEXT PRIMARY KEY)`);
            table = sqliteTable(`res_${type}`, { id: text('id').primaryKey() });
            tables.set(type, table);
          }
          return table;
        };
        for (const ref of new Set(tuples.flatMap((t) => [t.object, t.subject]))) {
          const type = typeOf(ref);
          tableFor(type);
          db.prepare(`INSERT OR IGNORE INTO "res_${type}" (id) VALUES (?)`).run(ref.slice(type.length + 1));
        }

        const withPermissions = createZanzoAdapter(new ZanzoEngine(translated.schema), zanzoTuples, {
          dialect: 'sqlite',
          warnOnNestedConditions: false,
        });

        const select = (type: string, permission: string, subject: string, extra = '', params: unknown[] = []) => {
          const table = tableFor(type) as any;
          const filter = dialect.sqlToQuery(withPermissions(subject, permission as never, type as never, table.id));
          return db
            .prepare(`SELECT id FROM "res_${type}" WHERE ${filter.sql}${extra}`)
            .all(...filter.params, ...params)
            .map((row: any) => `${type}:${row.id}`);
        };

        return {
          check: (object, permission, subject) =>
            select(typeOf(object), permission, subject, ' AND id = ?', [object.slice(typeOf(object).length + 1)]).length > 0,
          lookupResources: (type, permission, subject) => select(type, permission, subject),
        };
      },
    },
    {
      knownFailures: {
        // The case writes the workspace admin before attaching the document to the workspace,
        // the usual order in an application. materializeDerivedTuples only expands the tuple
        // being written, so attaching a resource later never inherits existing parent grants.
        'inheritance from a parent relation (tuple to userset)':
          'grants made on a parent before a resource is attached to it are never materialized',
        'a resource with several parents (diamond)':
          'grants made on a parent before a resource is attached to it are never materialized',
        'inheritance through a parent permission across three levels':
          'grants made on a parent before a resource is attached to it are never materialized',
      },
    },
  );
}
