import type { Context, MiddlewareHandler } from 'hono';
import {
  ZanzoAuthorizationError,
  createZanzoServer,
  type Authorizer,
  type RequestAuthz,
} from '@zanzojs/server';

export { engineAuthorizer, isAuthorizationError, ZanzoAuthorizationError } from '@zanzojs/server';
export type { Authorizer, RequestAuthz } from '@zanzojs/server';

/** Add to your app's Env to type `c.var.zanzo`. */
export interface ZanzoVariables {
  zanzo: RequestAuthz;
}
export type ZanzoEnv = { Variables: ZanzoVariables };

export interface ZanzoHonoOptions {
  /** `ZanzoSql` from `@zanzojs/sql`, or `engineAuthorizer(engine)` */
  authorizer: Authorizer | ((c: Context) => Authorizer);
  /** The authenticated actor, e.g. `` c => c.get('session') && `User:${c.get('session').userId}` `` */
  getActor(c: Context): string | null | undefined | Promise<string | null | undefined>;
  /** Request context for conditions, e.g. `` c => ({ ip: c.req.header('cf-connecting-ip') }) `` */
  getContext?(c: Context): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
  /**
   * Where the snapshot (`GET`) and check (`POST`) endpoints are served, or `false` to
   * serve none. @default '/zanzo'
   */
  basePath?: string | false;
}

/**
 * Sets `c.var.zanzo` for every request, serves the snapshot/check endpoints, and turns
 * `ZanzoAuthorizationError` thrown by handlers into 401/403 responses.
 *
 * @example
 * const app = new Hono<ZanzoEnv>();
 * app.use(zanzo({ authorizer: store, getActor: (c) => getUser(c) }));
 * app.get('/docs/:id', requirePermission('read', (c) => `Doc:${c.req.param('id')}`), handler);
 */
export function zanzo(options: ZanzoHonoOptions): MiddlewareHandler {
  const fixed = typeof options.authorizer === 'function' ? undefined : options.authorizer;
  const servers = new WeakMap<Authorizer, ReturnType<typeof createZanzoServer<Context>>>();
  const serverFor = (authorizer: Authorizer) => {
    let server = servers.get(authorizer);
    if (!server) {
      server = createZanzoServer<Context>({
        authorizer,
        getActor: options.getActor,
        ...(options.getContext ? { getContext: options.getContext } : {}),
      });
      servers.set(authorizer, server);
    }
    return server;
  };

  return async (c, next) => {
    // A factory lets Workers build the store from c.env (e.g. a D1 binding) per request
    const server = serverFor(fixed ?? (options.authorizer as (c: Context) => Authorizer)(c));
    const authz = await server.authorize(c);
    c.set('zanzo', authz);

    if (options.basePath !== false) {
      const response = await server.handle(c.req.raw, authz, options.basePath ?? '/zanzo');
      if (response) return response;
    }

    await next();
    if (c.error instanceof ZanzoAuthorizationError) {
      c.res = undefined;
      c.res = c.error.toResponse();
    }
  };
}

/**
 * Lets the request through only when the actor can perform `action` on the resource;
 * otherwise responds 401 (anonymous) or 403. Requires the `zanzo` middleware.
 */
export function requirePermission(
  action: string,
  resource: string | ((c: Context) => string | Promise<string>),
): MiddlewareHandler {
  return async (c, next) => {
    const authz = c.get('zanzo') as RequestAuthz | undefined;
    if (!authz) throw new Error('[Zanzo] requirePermission() needs app.use(zanzo(...)) first.');
    const ref = typeof resource === 'function' ? await resource(c) : resource;
    try {
      await authz.require(action, ref);
    } catch (error) {
      if (error instanceof ZanzoAuthorizationError) return error.toResponse();
      throw error;
    }
    await next();
  };
}
