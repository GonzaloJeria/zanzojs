import {
  ZanzoEngine,
  ZanzoError,
  ZanzoErrorCode,
  createZanzoSnapshot,
  type ConditionFunction,
  type EvaluationOptions,
  type ExpandTree,
  type LookupSubjectsResult,
  type SchemaData,
  type SnapshotOptions,
  type Tuple,
  type TupleChange,
  type TupleCondition,
  type TupleFilter,
  type WritePrecondition,
  type WriteRequest,
  type WriteResult,
} from '@zanzojs/core';
import type { Dialect, Row, SqlDriver, Statement } from './driver';
import { migrationSql, resolveTables, splitStatements, type TableNames } from './migrations';
import { SchemaPlan, typeOf } from './plan';

export interface ZanzoSqlOptions<TSchema extends SchemaData> {
  schema: TSchema;
  driver: SqlDriver;
  /** Caveat predicates, as in `new ZanzoEngine(schema, { conditions })` */
  conditions?: Record<string, ConditionFunction>;
  /** Table names. @default { tuples: 'zanzo_tuples', changes: 'zanzo_changes', guard: 'zanzo_guard' } */
  tables?: Partial<TableNames>;
  /** Maximum graph depth followed by a load, as in the engine. @default 50 */
  maxDepth?: number;
}

export interface CheckRequest {
  actor: string;
  action: string;
  resource: string;
}

export interface WatchResult {
  changes: TupleChange[];
  /** Pass it as `afterRevision` to the next call */
  revision: number;
}

/** Counters for the last operation; useful to see what a call costs on a metered database. */
export interface LoadStats {
  /** Round trips to the database */
  roundTrips: number;
  /** Statements sent */
  statements: number;
  /** Tuples read */
  rows: number;
}

const COLUMNS = 'object, relation, subject, condition, expires_at';
const MAX_DEPTH = 50;

/**
 * Zanzibar on SQL. Permissions are evaluated by `ZanzoEngine` on the part of the graph a
 * request needs, which is loaded one level per round trip:
 *
 * - checks walk forward from the resource and read only the relations the permission can
 *   reach, filtered to the actor where the schema allows it;
 * - lookups and snapshots walk backward from the actor along the `(subject, relation)` index.
 *
 * Nothing is materialized: a write is one tuple row plus one change-log row.
 */
export class ZanzoSql<TSchema extends SchemaData = SchemaData> {
  readonly schema: TSchema;
  readonly dialect: Dialect;
  readonly tables: TableNames;
  /** Cost of the most recent read operation */
  lastLoad: LoadStats = { roundTrips: 0, statements: 0, rows: 0 };

  private readonly driver: SqlDriver;
  private readonly plan: SchemaPlan;
  private readonly conditions: Record<string, ConditionFunction>;
  private readonly maxParams: number;
  private readonly maxDepth: number;
  private readonly live: string;

  constructor(options: ZanzoSqlOptions<TSchema>) {
    this.schema = options.schema;
    this.driver = options.driver;
    this.dialect = options.driver.dialect;
    this.tables = resolveTables(options.tables);
    this.plan = new SchemaPlan(options.schema);
    this.conditions = options.conditions ?? {};
    this.maxParams = Math.max(8, options.driver.maxParams ?? (this.dialect === 'sqlite' ? 100 : 10000));
    this.maxDepth = options.maxDepth ?? MAX_DEPTH;
    this.live = '(expires_at IS NULL OR expires_at > ?)';
  }

  // ─── Setup ──────────────────────────────────────────────────────

  /** The DDL for this store's tables, for migration tools. */
  migrationSql(): string {
    return migrationSql(this.dialect, this.tables);
  }

  /** Creates the tables and indexes if they do not exist. */
  async migrate(): Promise<void> {
    await this.driver.transaction(splitStatements(this.migrationSql()).map((sql) => ({ sql, params: [] })));
  }

  // ─── Checks ─────────────────────────────────────────────────────

  /** Whether `actor` can perform `action` on `resource`. */
  async check(actor: string, action: string, resource: string, options?: EvaluationOptions): Promise<boolean> {
    const [result] = await this.checkMany([{ actor, action, resource }], options);
    return result!;
  }

  /**
   * Several checks with their graph loads merged: the number of round trips is the depth
   * of the deepest check, not the sum.
   */
  async checkMany(checks: readonly CheckRequest[], options?: EvaluationOptions): Promise<boolean[]> {
    if (checks.length === 0) return [];
    const tuples = await this.loadForward(
      checks.map((c) => ({ object: c.resource, actor: c.actor, names: [c.action] })),
      options?.contextualTuples,
    );
    const engine = this.engineWith(tuples);
    return checks.map((c) => engine.can(c.actor, c.action as never, c.resource as never, options));
  }

  /** Every action of `resource`'s type that `actor` can perform on it. */
  async actions(actor: string, resource: string): Promise<string[]> {
    const type = this.plan.compiled.types.get(typeOf(resource));
    if (!type) return [];
    const tuples = await this.loadForward([{ object: resource, actor, names: type.actions }]);
    return this.engineWith(tuples).evaluateAllActions(actor, resource);
  }

  // ─── Lookups ────────────────────────────────────────────────────

  /** Resources of `resourceType` on which `actor` can perform `action`. */
  async lookupResources(actor: string, action: string, resourceType: string, options?: EvaluationOptions): Promise<string[]> {
    const engine = await this.engineFor(actor, options);
    return engine.lookupResources(actor, action as never, resourceType as never, options);
  }

  /** Subjects of `subjectType` that can perform `action` on `resource`. */
  async lookupSubjects(resource: string, action: string, subjectType: string, options?: EvaluationOptions): Promise<LookupSubjectsResult> {
    // Candidates are the subjects reachable from the resource through any relation
    const tuples = await this.loadForward([{ object: resource, actor: null, names: [action] }], options?.contextualTuples, true);
    return this.engineWith(tuples).lookupSubjects(resource as never, action as never, subjectType as never, options);
  }

  /** The tree of usersets that grants `action` on `resource` (Zanzibar Expand). */
  async expand(resource: string, action: string): Promise<ExpandTree | null> {
    const tuples = await this.loadForward([{ object: resource, actor: null, names: [action] }]);
    return this.engineWith(tuples).expand(resource as never, action as never);
  }

  /** A snapshot of everything `actor` can do, for `ZanzoClient` on the frontend. */
  async snapshot(actor: string, options?: SnapshotOptions): Promise<Record<string, string[]>> {
    return createZanzoSnapshot(await this.engineFor(actor), actor, options);
  }

  /**
   * A `ZanzoEngine` holding every tuple that can grant `actor` anything. Synchronous checks
   * of that actor on it are exact, so one load can serve a whole request. Its size grows
   * with what the actor can reach: prefer `check` for a few resources.
   */
  async engineFor(actor: string, options?: EvaluationOptions): Promise<ZanzoEngine<TSchema>> {
    return this.engineWith(await this.loadBackward(actor, options?.contextualTuples));
  }

  // ─── Reads ──────────────────────────────────────────────────────

  /** Live tuples matching the filter (Zanzibar Read). */
  async read(filter: TupleFilter = {}, options: { limit?: number } = {}): Promise<Tuple[]> {
    const where = this.filterSql(filter);
    const limit = options.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(options.limit))}` : '';
    const [rows] = await this.driver.query([
      { sql: `SELECT ${COLUMNS} FROM ${this.tables.tuples} WHERE ${where.sql} AND ${this.live} ORDER BY id${limit}`, params: [...where.params, this.now()] },
    ]);
    return rows!.map((row) => this.decode(row));
  }

  /** The latest revision: the id of the last change-log row. */
  async revision(): Promise<number> {
    const [rows] = await this.driver.query([{ sql: `SELECT COALESCE(MAX(revision), 0) AS revision FROM ${this.tables.changes}`, params: [] }]);
    return Number(rows![0]?.['revision'] ?? 0);
  }

  /**
   * Changes after `afterRevision`, oldest first (Zanzibar Watch). Use it to invalidate
   * caches or replicate tuples across instances.
   *
   * @throws {ZanzoError} WATCH_EXPIRED when `afterRevision` was pruned with `pruneChanges`.
   */
  async watch(afterRevision: number, options: { limit?: number } = {}): Promise<WatchResult> {
    const limit = Math.max(1, Math.floor(options.limit ?? 1000));
    const [bounds, rows] = await this.driver.query([
      { sql: `SELECT MIN(revision) AS min_revision FROM ${this.tables.changes}`, params: [] },
      {
        sql: `SELECT revision, operation, ${COLUMNS} FROM ${this.tables.changes} WHERE revision > ? ORDER BY revision LIMIT ${limit}`,
        params: [afterRevision],
      },
    ]);
    const min = bounds![0]?.['min_revision'];
    if (min !== null && min !== undefined && afterRevision < Number(min) - 1) {
      throw new ZanzoError(ZanzoErrorCode.WATCH_EXPIRED, `[Zanzo] Revision ${afterRevision} is no longer in the change log. Reload the tuples and watch from the current revision.`);
    }
    const changes: TupleChange[] = rows!.map((row) => ({
      revision: Number(row['revision']),
      operation: row['operation'] as 'touch' | 'delete',
      tuple: this.decode(row),
    }));
    return { changes, revision: changes.length > 0 ? changes[changes.length - 1]!.revision : afterRevision };
  }

  // ─── Writes ─────────────────────────────────────────────────────

  /**
   * Applies tuple updates atomically, after checking the preconditions in the same
   * transaction (Zanzibar Write). Each update costs one tuple row and one change-log row.
   *
   * @throws {ZanzoError} PRECONDITION_FAILED, TUPLE_ALREADY_EXISTS (for `create`), or a
   *   validation error. Nothing is written when it throws.
   */
  async write(request: WriteRequest): Promise<WriteResult> {
    const validator = new ZanzoEngine(this.schema, { conditions: this.conditions });
    const statements: Statement[] = this.preconditionStatements(request.preconditions);
    const now = this.now();

    for (const { operation, tuple } of request.updates) {
      validator.addTuple(tuple);
      const key = [tuple.object, tuple.relation, tuple.subject];
      if (operation === 'delete') {
        statements.push(
          {
            sql: `INSERT INTO ${this.tables.changes} (operation, ${COLUMNS}) SELECT 'delete', ${COLUMNS} FROM ${this.tables.tuples} WHERE object = ? AND relation = ? AND subject = ?`,
            params: key,
          },
          { sql: `DELETE FROM ${this.tables.tuples} WHERE object = ? AND relation = ? AND subject = ?`, params: key },
        );
        continue;
      }
      if (operation === 'create') {
        statements.push({
          sql: `INSERT INTO ${this.tables.guard} (kind) SELECT 'e' WHERE EXISTS (SELECT 1 FROM ${this.tables.tuples} WHERE object = ? AND relation = ? AND subject = ? AND ${this.live})`,
          params: [...key, now],
        });
      } else if (operation !== 'touch') {
        throw new ZanzoError(ZanzoErrorCode.INVALID_WRITE, `[Zanzo] Unknown write operation "${String(operation)}".`);
      }
      const values = [...key, this.encodeCondition(tuple.condition), tuple.expiresAt ? this.encodeTime(tuple.expiresAt) : null];
      statements.push(
        {
          sql: `INSERT INTO ${this.tables.tuples} (${COLUMNS}) VALUES (?, ?, ?, ?, ?) ON CONFLICT (object, relation, subject) DO UPDATE SET condition = excluded.condition, expires_at = excluded.expires_at`,
          params: values,
        },
        { sql: `INSERT INTO ${this.tables.changes} (operation, ${COLUMNS}) VALUES ('touch', ?, ?, ?, ?, ?)`, params: values },
      );
    }

    statements.push({ sql: `SELECT COALESCE(MAX(revision), 0) AS revision FROM ${this.tables.changes}`, params: [] });
    const results = await this.transaction(statements);
    return { revision: Number(results[results.length - 1]![0]?.['revision'] ?? 0) };
  }

  /** Grants a tuple: `touch` semantics, it replaces an existing tuple's expiration and condition. */
  async grant(tuple: Tuple): Promise<WriteResult> {
    return this.write({ updates: [{ operation: 'touch', tuple }] });
  }

  /** Revokes a tuple. Revoking a missing tuple is not an error. */
  async revoke(tuple: Tuple): Promise<WriteResult> {
    return this.write({ updates: [{ operation: 'delete', tuple }] });
  }

  /**
   * Deletes every tuple matching the filter (at least one field is required), atomically
   * with the preconditions.
   */
  async deleteTuples(filter: TupleFilter, options: { preconditions?: WritePrecondition[] } = {}): Promise<{ deleted: number; revision: number }> {
    if (filter.object === undefined && filter.relation === undefined && filter.subject === undefined) {
      throw new ZanzoError(ZanzoErrorCode.INVALID_WRITE, '[Zanzo] deleteTuples() needs a filter with object, relation or subject.');
    }
    const where = this.filterSql(filter);
    const statements = [
      ...this.preconditionStatements(options.preconditions),
      {
        sql: `INSERT INTO ${this.tables.changes} (operation, ${COLUMNS}) SELECT 'delete', ${COLUMNS} FROM ${this.tables.tuples} WHERE ${where.sql}`,
        params: where.params,
      },
      { sql: `DELETE FROM ${this.tables.tuples} WHERE ${where.sql} RETURNING id`, params: where.params },
      { sql: `SELECT COALESCE(MAX(revision), 0) AS revision FROM ${this.tables.changes}`, params: [] },
    ];
    const results = await this.transaction(statements);
    return { deleted: results[results.length - 2]!.length, revision: Number(results[results.length - 1]![0]?.['revision'] ?? 0) };
  }

  /** Physically removes expired tuples. They are already ignored by every read; this only frees space. */
  async deleteExpired(): Promise<number> {
    const [rows] = await this.driver.transaction([
      { sql: `DELETE FROM ${this.tables.tuples} WHERE expires_at IS NOT NULL AND expires_at <= ? RETURNING id`, params: [this.now()] },
    ]);
    return rows!.length;
  }

  /** Drops change-log rows older than `beforeRevision`, always keeping the latest one. */
  async pruneChanges(beforeRevision: number): Promise<void> {
    await this.driver.transaction([
      {
        sql: `DELETE FROM ${this.tables.changes} WHERE revision < ? AND revision < (SELECT MAX(revision) FROM ${this.tables.changes})`,
        params: [beforeRevision],
      },
    ]);
  }

  // ─── Loading ────────────────────────────────────────────────────

  /**
   * Loads the tuples needed to evaluate `names` on each seed object, one graph level per
   * round trip. With an actor, relations that accept the actor's type directly are read
   * only for that actor (and its wildcard), using the unique index.
   */
  private async loadForward(
    seeds: readonly { object: string; actor: string | null; names: readonly string[] }[],
    contextual: readonly Tuple[] = [],
    allRelations = false,
  ): Promise<Tuple[]> {
    const stats: LoadStats = { roundTrips: 0, statements: 0, rows: 0 };
    const needed = new Map<string, Set<string>>();
    if (allRelations) {
      for (const type of this.plan.compiled.types.values()) needed.set(type.name, new Set(type.relations.keys()));
    }
    for (const seed of seeds) {
      for (const [type, relations] of this.plan.neededAll(typeOf(seed.object), seed.names)) {
        let set = needed.get(type);
        if (!set) needed.set(type, (set = new Set()));
        for (const r of relations) set.add(r);
      }
    }

    const contextualByObject = groupBy(contextual, (t) => t.object);
    const seen = new Set<string>();
    let frontier: { object: string; actor: string | null }[] = [];
    const visit = (object: string, actor: string | null) => {
      const key = `${actor ?? ''}\u0000${object}`;
      if (seen.has(key)) return;
      seen.add(key);
      frontier.push({ object, actor });
      for (const t of contextualByObject.get(object) ?? []) follow(t, actor);
    };
    const follow = (t: Tuple, actor: string | null) => {
      const hash = t.subject.indexOf('#');
      if (hash !== -1) visit(t.subject.slice(0, hash), actor);
      else if (!t.subject.endsWith(':*') && (allRelations || this.plan.isTupleset(typeOf(t.object), t.relation))) visit(t.subject, actor);
    };
    for (const seed of seeds) visit(seed.object, seed.actor);

    const tuples: Tuple[] = [];
    for (let depth = 0; frontier.length > 0; depth++) {
      if (depth > this.maxDepth) {
        throw new ZanzoError(ZanzoErrorCode.MAX_DEPTH_EXCEEDED, `[Zanzo] Graph deeper than ${this.maxDepth} levels.`);
      }
      const batches = this.forwardStatements(frontier, needed);
      frontier = [];
      if (batches.length === 0) break;
      const results = await this.driver.query(batches.map((b) => b.statement));
      stats.roundTrips++;
      stats.statements += batches.length;
      results.forEach((rows, i) => {
        const actor = batches[i]!.actor;
        for (const row of rows) {
          const tuple = this.decode(row);
          tuples.push(tuple);
          stats.rows++;
          follow(tuple, actor);
        }
      });
    }
    this.lastLoad = stats;
    return tuples;
  }

  /** One level of a forward load: statements per actor, so rows can be followed for the right actor. */
  private forwardStatements(
    frontier: readonly { object: string; actor: string | null }[],
    needed: ReadonlyMap<string, ReadonlySet<string>>,
  ): { statement: Statement; actor: string | null }[] {
    const piecesByActor = new Map<string | null, Statement[]>();
    const groups = new Map<string, { type: string; actor: string | null; objects: string[] }>();
    for (const { object, actor } of frontier) {
      const type = typeOf(object);
      const key = `${type}\u0000${actor ?? ''}`;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { type, actor, objects: [] }));
      group.objects.push(object);
    }

    const now = this.now();
    for (const { type, actor, objects } of groups.values()) {
      const relations = needed.get(type);
      if (!relations || relations.size === 0) continue;
      const actorType = actor !== null && !actor.includes('#') ? typeOf(actor) : null;
      const full: string[] = [];
      const direct: string[] = [];
      const ranges: { relation: string; type: string }[] = [];
      for (const relation of relations) {
        if (actorType === null || this.plan.isTupleset(type, relation)) {
          full.push(relation);
          continue;
        }
        let accepted = false;
        for (const s of this.plan.allowed(type, relation)) {
          if (s.relation !== undefined) ranges.push({ relation, type: s.type });
          else if (s.type === actorType) accepted = true;
        }
        if (accepted) direct.push(relation);
      }

      let pieces = piecesByActor.get(actor);
      if (!pieces) piecesByActor.set(actor, (pieces = []));
      const budget = Math.max(1, this.maxParams - 8 - Math.max(full.length, direct.length));
      for (const chunk of chunks(objects, budget)) {
        const objectList = placeholders(chunk.length);
        if (full.length > 0) {
          pieces.push({
            sql: `SELECT ${COLUMNS} FROM ${this.tables.tuples} WHERE object IN (${objectList}) AND relation IN (${placeholders(full.length)}) AND ${this.live}`,
            params: [...chunk, ...full, now],
          });
        }
        if (direct.length > 0) {
          pieces.push({
            sql: `SELECT ${COLUMNS} FROM ${this.tables.tuples} WHERE object IN (${objectList}) AND relation IN (${placeholders(direct.length)}) AND subject IN (?, ?) AND ${this.live}`,
            params: [...chunk, ...direct, actor, `${actorType}:*`, now],
          });
        }
        for (const range of ranges) {
          // Usersets of a type sort between "Type:" and "Type;" (';' follows ':')
          pieces.push({
            sql: `SELECT ${COLUMNS} FROM ${this.tables.tuples} WHERE object IN (${objectList}) AND relation = ? AND subject >= ? AND subject < ? AND ${this.live}`,
            params: [...chunk, range.relation, `${range.type}:`, `${range.type};`, now],
          });
        }
      }
    }
    const batches: { statement: Statement; actor: string | null }[] = [];
    for (const [actor, pieces] of piecesByActor) {
      for (const statement of this.combine(pieces)) batches.push({ statement, actor });
    }
    return batches;
  }

  /** Loads every tuple through which `actor` can be granted something, walking backward. */
  private async loadBackward(actor: string, contextual: readonly Tuple[] = []): Promise<Tuple[]> {
    const stats: LoadStats = { roundTrips: 0, statements: 0, rows: 0 };
    const contextualBySubject = groupBy(contextual, (t) => t.subject);
    const seen = new Set<string>();
    let frontier: string[] = [];
    const visit = (subject: string) => {
      if (seen.has(subject)) return;
      seen.add(subject);
      frontier.push(subject);
      for (const t of contextualBySubject.get(subject) ?? []) follow(t);
    };
    const follow = (t: Tuple) => {
      const type = typeOf(t.object);
      if (this.plan.usersets.has(`${type}#${t.relation}`)) visit(`${t.object}#${t.relation}`);
      if (this.plan.parentTypes.has(type)) visit(t.object);
    };
    visit(actor);
    if (!actor.includes('#')) visit(`${typeOf(actor)}:*`);

    const tuples: Tuple[] = [];
    for (let depth = 0; frontier.length > 0; depth++) {
      if (depth > this.maxDepth) {
        throw new ZanzoError(ZanzoErrorCode.MAX_DEPTH_EXCEEDED, `[Zanzo] Graph deeper than ${this.maxDepth} levels.`);
      }
      const now = this.now();
      const pieces = chunks(frontier, this.maxParams - 2).map((chunk) => ({
        sql: `SELECT ${COLUMNS} FROM ${this.tables.tuples} WHERE subject IN (${placeholders(chunk.length)}) AND ${this.live}`,
        params: [...chunk, now],
      }));
      frontier = [];
      const statements = this.combine(pieces);
      const results = await this.driver.query(statements);
      stats.roundTrips++;
      stats.statements += statements.length;
      for (const rows of results) {
        for (const row of rows) {
          const tuple = this.decode(row);
          tuples.push(tuple);
          stats.rows++;
          follow(tuple);
        }
      }
    }
    this.lastLoad = stats;
    return tuples;
  }

  /** Joins SELECTs with UNION ALL while they fit in the parameter budget. */
  private combine(pieces: Statement[]): Statement[] {
    const statements: Statement[] = [];
    let sql: string[] = [];
    let params: unknown[] = [];
    for (const piece of pieces) {
      if (sql.length > 0 && params.length + piece.params.length > this.maxParams) {
        statements.push({ sql: sql.join(' UNION ALL '), params });
        sql = [];
        params = [];
      }
      sql.push(piece.sql);
      params.push(...piece.params);
    }
    if (sql.length > 0) statements.push({ sql: sql.join(' UNION ALL '), params });
    return statements;
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private engineWith(tuples: Tuple[]): ZanzoEngine<TSchema> {
    const engine = new ZanzoEngine<TSchema>(this.schema, { conditions: this.conditions });
    engine.load(tuples);
    return engine;
  }

  private preconditionStatements(preconditions: readonly WritePrecondition[] = []): Statement[] {
    return preconditions.map(({ operation, filter }) => {
      if (operation !== 'must_match' && operation !== 'must_not_match') {
        throw new ZanzoError(ZanzoErrorCode.INVALID_WRITE, `[Zanzo] Unknown precondition "${String(operation)}".`);
      }
      const where = this.filterSql(filter);
      return {
        sql: `INSERT INTO ${this.tables.guard} (kind) SELECT 'p' WHERE ${operation === 'must_match' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ${this.tables.tuples} WHERE ${where.sql} AND ${this.live})`,
        params: [...where.params, this.now()],
      };
    });
  }

  private async transaction(statements: Statement[]): Promise<Row[][]> {
    try {
      return await this.driver.transaction(statements);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (message.includes('zanzo_precondition')) {
        throw new ZanzoError(ZanzoErrorCode.PRECONDITION_FAILED, '[Zanzo] Write precondition failed; nothing was written.');
      }
      if (message.includes('zanzo_exists')) {
        throw new ZanzoError(ZanzoErrorCode.TUPLE_ALREADY_EXISTS, '[Zanzo] create: the tuple already exists; nothing was written. Use touch to overwrite it.');
      }
      throw error;
    }
  }

  private filterSql(filter: TupleFilter): Statement {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const column of ['object', 'relation', 'subject'] as const) {
      const value = filter[column];
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    return { sql: clauses.length > 0 ? clauses.join(' AND ') : '1 = 1', params };
  }

  private now(): unknown {
    return this.encodeTime(new Date());
  }

  private encodeTime(date: Date): unknown {
    return this.dialect === 'postgres' ? date : date.getTime();
  }

  private encodeCondition(condition: TupleCondition | undefined): unknown {
    return condition ? JSON.stringify(condition) : null;
  }

  private decode(row: Row): Tuple {
    const tuple: Tuple = { object: String(row['object']), relation: String(row['relation']), subject: String(row['subject']) };
    const expiresAt = row['expires_at'];
    if (expiresAt !== null && expiresAt !== undefined) {
      tuple.expiresAt = expiresAt instanceof Date ? expiresAt : new Date(typeof expiresAt === 'string' && this.dialect === 'postgres' ? expiresAt : Number(expiresAt));
    }
    const condition = row['condition'];
    if (condition !== null && condition !== undefined) {
      tuple.condition = (typeof condition === 'string' ? JSON.parse(condition) : condition) as TupleCondition;
    }
    return tuple;
  }
}

/** Creates a SQL-backed Zanzo store. */
export function createZanzoSql<TSchema extends SchemaData>(options: ZanzoSqlOptions<TSchema>): ZanzoSql<TSchema> {
  return new ZanzoSql(options);
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    let list = map.get(k);
    if (!list) map.set(k, (list = []));
    list.push(item);
  }
  return map;
}
