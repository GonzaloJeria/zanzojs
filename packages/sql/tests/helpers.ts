import { createRequire } from 'node:module';
import { ZanzoBuilder, type ConditionFunction, type SchemaData } from '@zanzojs/core';
import { PGlite } from '@electric-sql/pglite';
import { createZanzoSql, sqliteDriver, pgliteDriver, type SqlDriver, type ZanzoSql } from '../src/index';
import type { NeutralSchema, NeutralTuple } from '../../core/conformance/model';
import { toTuple } from '../../core/conformance/convert';

let DatabaseSync: any;
try {
  DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync;
} catch {
  DatabaseSync = undefined;
}

export const hasSqlite = DatabaseSync !== undefined;

export type Backend = 'sqlite' | 'postgres';
export const backends: Backend[] = hasSqlite ? ['sqlite', 'postgres'] : ['postgres'];

let pglite: PGlite | undefined;

/** A fresh database for a backend. Postgres reuses one PGlite instance with a new schema each time. */
export async function createDriver(backend: Backend): Promise<SqlDriver> {
  if (backend === 'sqlite') return sqliteDriver(new DatabaseSync(':memory:'));
  pglite ??= new PGlite();
  const schemaName = `t${Math.random().toString(36).slice(2)}`;
  await pglite.exec(`CREATE SCHEMA ${schemaName}; SET search_path TO ${schemaName};`);
  return pgliteDriver(pglite);
}

export function toSchema(neutral: NeutralSchema): SchemaData {
  let builder: ZanzoBuilder<any> = new ZanzoBuilder();
  for (const [type, entity] of Object.entries(neutral)) {
    builder = builder.entity(type, { relations: entity.relations ?? {}, permissions: entity.permissions ?? {} });
  }
  return builder.build();
}

export async function createStore(
  backend: Backend,
  schema: SchemaData,
  tuples: NeutralTuple[] = [],
  conditions: Record<string, ConditionFunction> = {},
): Promise<ZanzoSql> {
  const store = createZanzoSql({ schema, driver: await createDriver(backend), conditions });
  await store.migrate();
  if (tuples.length > 0) await store.write({ updates: tuples.map((t) => ({ operation: 'touch' as const, tuple: toTuple(t) })) });
  return store;
}
