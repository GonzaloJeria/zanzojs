import { ZanzoEngine, ZanzoError, ZanzoErrorCode, createZanzoSnapshot, type EvaluationOptions } from '@zanzojs/core';

// ─── Authorizer: what the server needs from a permission backend ─────

export interface CheckRequest {
  actor: string;
  action: string;
  resource: string;
}

/**
 * A permission backend. `@zanzojs/sql`'s `ZanzoSql` implements it as is; wrap an in-memory
 * `ZanzoEngine` with `engineAuthorizer`.
 */
export interface Authorizer {
  checkMany(checks: readonly CheckRequest[], options?: EvaluationOptions): Promise<boolean[]> | boolean[];
  lookupResources(actor: string, action: string, resourceType: string, options?: EvaluationOptions): Promise<string[]> | string[];
  snapshot(actor: string): Promise<Record<string, string[]>> | Record<string, string[]>;
}

/** Serves permissions from an in-memory engine (tests, small apps, edge caches). */
export function engineAuthorizer(engine: ZanzoEngine<any>): Authorizer {
  return {
    checkMany: (checks, options) => checks.map((c) => engine.can(c.actor, c.action as never, c.resource as never, options)),
    lookupResources: (actor, action, type, options) => engine.lookupResources(actor, action as never, type as never, options),
    snapshot: (actor) => createZanzoSnapshot(engine, actor),
  };
}

// ─── Errors ─────────────────────────────────────────────────────────

/** Thrown by `require` when the actor is missing (401) or lacks the permission (403). */
export class ZanzoAuthorizationError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly action?: string,
    readonly resource?: string,
  ) {
    super(status === 401 ? '[Zanzo] Authentication required.' : `[Zanzo] Forbidden: cannot ${action} ${resource}.`);
    this.name = 'ZanzoAuthorizationError';
  }

  /** A JSON response that does not reveal whether the resource exists beyond what was asked. */
  toResponse(): Response {
    const body = this.status === 401 ? { error: 'unauthenticated' } : { error: 'forbidden', action: this.action, resource: this.resource };
    return Response.json(body, { status: this.status });
  }
}

export function isAuthorizationError(error: unknown): error is ZanzoAuthorizationError {
  return error instanceof ZanzoAuthorizationError;
}

// ─── Per-request authorization ──────────────────────────────────────

export interface RequestAuthz {
  /** The authenticated actor (e.g. `User:42`), or null for anonymous requests */
  readonly actor: string | null;
  /**
   * Whether the actor can perform `action` on `resource`. Results are memoized for the
   * request, and calls made in the same tick are sent as a single `checkMany`.
   */
  can(action: string, resource: string): Promise<boolean>;
  /** Like `can`, but throws `ZanzoAuthorizationError` (401 or 403) when not allowed. */
  require(action: string, resource: string): Promise<void>;
  /** Resource ids of a type the actor can perform `action` on, for `WHERE id IN (…)`. */
  lookup(action: string, resourceType: string): Promise<string[]>;
  /** Everything the actor can do, for `ZanzoClient` on the frontend. */
  snapshot(): Promise<Record<string, string[]>>;
}

export interface ZanzoServerOptions<TContext> {
  authorizer: Authorizer;
  /**
   * Resolves the actor from the framework's request context, e.g. from a session.
   * Return null for anonymous requests.
   */
  getActor(context: TContext): string | null | undefined | Promise<string | null | undefined>;
  /** Request context (caveat inputs such as IP or time) passed to every check. */
  getContext?(context: TContext): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
}

export interface ZanzoServer<TContext> {
  /** Builds the per-request authorization object. Call it once per request. */
  authorize(context: TContext): Promise<RequestAuthz>;
  /**
   * Handles Zanzo's HTTP endpoints under `basePath` and returns null for any other path:
   * - `GET  {basePath}/snapshot` → the actor's snapshot
   * - `POST {basePath}/check` with `{ checks: [{ action, resource }] }` → `{ results: boolean[] }`
   *
   * The actor always comes from `getActor`, never from the request body.
   */
  handle(request: Request, authz: RequestAuthz, basePath?: string): Promise<Response | null>;
}

const MAX_CHECKS_PER_REQUEST = 100;
const CLIENT_ERRORS = new Set<string>([ZanzoErrorCode.INVALID_INPUT, ZanzoErrorCode.INVALID_ENTITY_REF, ZanzoErrorCode.INVALID_FIELD_SEPARATOR]);

export function createZanzoServer<TContext>(options: ZanzoServerOptions<TContext>): ZanzoServer<TContext> {
  const { authorizer } = options;

  async function authorize(context: TContext): Promise<RequestAuthz> {
    const actor = (await options.getActor(context)) ?? null;
    const requestContext = options.getContext ? await options.getContext(context) : undefined;
    const evaluation: EvaluationOptions | undefined = requestContext ? { context: requestContext } : undefined;

    const results = new Map<string, Promise<boolean>>();
    let pending: { check: CheckRequest; resolve: (value: boolean) => void; reject: (error: unknown) => void }[] = [];

    const flush = () => {
      const batch = pending;
      pending = [];
      Promise.resolve()
        .then(() => authorizer.checkMany(batch.map((p) => p.check), evaluation))
        .then(
          (answers) => batch.forEach((p, i) => p.resolve(answers[i] === true)),
          (error) => batch.forEach((p) => p.reject(error)),
        );
    };

    const can = (action: string, resource: string): Promise<boolean> => {
      if (actor === null) return Promise.resolve(false);
      const key = `${action}\u0000${resource}`;
      let result = results.get(key);
      if (!result) {
        result = new Promise<boolean>((resolve, reject) => {
          if (pending.length === 0) queueMicrotask(flush);
          pending.push({ check: { actor, action, resource }, resolve, reject });
        });
        results.set(key, result);
      }
      return result;
    };

    return {
      actor,
      can,
      async require(action, resource) {
        if (actor === null) throw new ZanzoAuthorizationError(401);
        if (!(await can(action, resource))) throw new ZanzoAuthorizationError(403, action, resource);
      },
      async lookup(action, resourceType) {
        if (actor === null) return [];
        return authorizer.lookupResources(actor, action, resourceType, evaluation);
      },
      async snapshot() {
        if (actor === null) return {};
        return authorizer.snapshot(actor);
      },
    };
  }

  async function handle(request: Request, authz: RequestAuthz, basePath = '/zanzo'): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    const base = basePath.replace(/\/+$/, '');
    if (path !== `${base}/snapshot` && path !== `${base}/check`) return null;
    if (authz.actor === null) return new ZanzoAuthorizationError(401).toResponse();

    if (path === `${base}/snapshot`) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      return Response.json(await authz.snapshot(), { headers: { 'cache-control': 'private, no-store' } });
    }

    if (request.method !== 'POST') return methodNotAllowed('POST');
    let checks: { action: string; resource: string }[];
    try {
      const body = (await request.json()) as { checks?: unknown };
      if (!Array.isArray(body?.checks) || body.checks.length > MAX_CHECKS_PER_REQUEST) throw new Error();
      checks = body.checks.map((c: any) => {
        if (typeof c?.action !== 'string' || typeof c?.resource !== 'string') throw new Error();
        return { action: c.action, resource: c.resource };
      });
    } catch {
      return Response.json({ error: 'bad_request', message: `Expected { checks: [{ action, resource }] } with at most ${MAX_CHECKS_PER_REQUEST} checks.` }, { status: 400 });
    }
    try {
      const results = await Promise.all(checks.map((c) => authz.can(c.action, c.resource)));
      return Response.json({ results }, { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      // Malformed references are client errors; anything else propagates to the framework
      if (error instanceof ZanzoError && CLIENT_ERRORS.has(error.code)) {
        return Response.json({ error: 'bad_request', message: error.message }, { status: 400 });
      }
      throw error;
    }
  }

  return { authorize, handle };
}

function methodNotAllowed(allow: string): Response {
  return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { allow } });
}
