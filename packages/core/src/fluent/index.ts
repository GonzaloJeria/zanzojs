import type { SchemaData } from '../builder/index';
import type { ZanzoEngine } from '../engine/index';
import type { AccessibleResult, Tuple } from '../types/index';

/**
 * Intermediate builder for `engine.for(actor)`.
 * Provides `can(action)` and `listAccessible(entityType)`.
 */
export class ForBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private actor: string,
  ) {}

  /**
   * Begins a permission check for a specific action.
   * Chain with `.on(resource)` to get the boolean result.
   *
   * @example engine.for('User:alice').can('view').on('Document:doc1')
   */
  can(action: string): CanBuilder<TSchema> {
    return new CanBuilder(this.engine, this.actor, action);
  }

  /**
   * Lists all objects of a given entity type that the actor can access,
   * along with the granted actions for each object.
   *
   * @example engine.for('User:alice').listAccessible('Document')
   */
  listAccessible(entityType: string): AccessibleResult[] {
    const results: AccessibleResult[] = [];
    const index = this.engine.getIndex();

    for (const [objectKey] of index) {
      // Only consider objects of the requested entity type
      if (!objectKey.startsWith(`${entityType}:`)) continue;

      const actions = this.engine.evaluateAllActions(this.actor, objectKey);
      if (actions.length > 0) {
        results.push({ object: objectKey, actions });
      }
    }

    return results;
  }
}

/**
 * Intermediate builder for `engine.for(actor).can(action)`.
 * Call `.on(resource)` to evaluate.
 */
export class CanBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private actor: string,
    private action: string,
  ) {}

  /**
   * Evaluates the permission check against a specific resource.
   * @returns `true` if the actor is authorized, `false` otherwise.
   */
  on(resource: string): boolean {
    return this.engine.can(this.actor, this.action as any, resource as any);
  }
}

/**
 * Grants a permission by adding a tuple to the engine's in-memory index.
 * 
 * **When to use:**
 * - Unit tests: hydrate the engine without a database
 * - Seeds and development scripts
 * - Permission simulation sandboxes (evaluate without persisting)
 * 
 * **Not for production writes:** In a per-request serverless flow, mutations
 * via grant() are ephemeral and disappear when the request ends.
 * To persist permissions, write directly to your database and use
 * expandTuples() to materialize derived tuples.
 */
export class GrantBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private relation: string,
  ) {}

  to(subject: string): GrantToBuilder<TSchema> {
    return new GrantToBuilder(this.engine, this.relation, subject);
  }
}

/**
 * Intermediate builder for `engine.grant(relation).to(subject)`.
 * Chain with `.on(object)`.
 */
export class GrantToBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private relation: string,
    private subject: string,
  ) {}

  on(object: string): GrantOnBuilder<TSchema> {
    const tuple: Tuple = { subject: this.subject, relation: this.relation, object };
    this.engine.addTuple(tuple);
    return new GrantOnBuilder(this.engine, tuple);
  }
}

/**
 * Terminal builder for `engine.grant().to().on()`.
 * Optionally chain `.until(date)` to set an expiration.
 */
export class GrantOnBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private tuple: Tuple,
  ) {}

  /**
   * Sets an expiration date on the granted tuple.
   * The tuple is re-stored with the `expiresAt` field set.
   */
  until(date: Date): void {
    // Remove the previously added tuple without expiration and re-add with expiresAt
    this.engine.removeTuple(this.tuple);
    this.tuple.expiresAt = date;
    this.engine.addTuple(this.tuple);
  }
}

/**
 * Revokes a permission by removing a tuple from the engine's in-memory index.
 * 
 * **When to use:**
 * - Unit tests: hydrate the engine without a database
 * - Seeds and development scripts
 * - Permission simulation sandboxes (evaluate without persisting)
 * 
 * **Not for production writes:** In a per-request serverless flow, mutations
 * via revoke() are ephemeral and disappear when the request ends.
 * To persist permissions, write directly to your database and use
 * collapseTuples() to remove derived tuples.
 */
export class RevokeBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private relation: string,
  ) {}

  from(subject: string): RevokeFromBuilder<TSchema> {
    return new RevokeFromBuilder(this.engine, this.relation, subject);
  }
}

/**
 * Terminal builder for `engine.revoke(relation).from(subject)`.
 * Call `.on(object)` to execute the revocation.
 */
export class RevokeFromBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private relation: string,
    private subject: string,
  ) {}

  on(object: string): void {
    this.engine.removeTuple({ subject: this.subject, relation: this.relation, object });
  }
}
