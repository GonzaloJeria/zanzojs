import { describe, it, expect } from 'vitest';
import { ZanzoBuilder, ZanzoEngine, ZanzoError, ZanzoErrorCode } from '../src/index';

const schema = new ZanzoBuilder()
  .entity('User', { relations: {}, permissions: {} })
  .entity('Group', { relations: { member: ['User', 'Group#member'] }, permissions: {} })
  .entity('Folder', {
    relations: { parent: 'Folder', viewer: ['User', 'Group#member'] },
    permissions: { view: 'viewer | parent->view' },
  })
  .entity('Document', {
    relations: {
      parent: 'Folder',
      owner: 'User',
      editor: ['User', 'Group#member'],
      viewer: ['User', 'User:*', 'Group#member'],
      banned: 'User',
    },
    permissions: {
      edit: 'owner | editor',
      view: '(viewer | edit | parent->view) - banned',
      delete: ['owner'],
    },
  })
  .build();

describe('Expression syntax through the public API', () => {
  it('infers actions from permission names when actions are omitted', () => {
    expect(schema.Document.actions).toEqual(['edit', 'view', 'delete']);
  });

  it('evaluates computed permissions, recursive inheritance, usersets, wildcards and exclusions', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('member').to('User:bob').on('Group:backend');
    engine.grant('member').to('Group:backend#member').on('Group:eng');
    engine.grant('viewer').to('Group:eng#member').on('Folder:root');
    engine.grant('parent').to('Folder:root').on('Folder:specs');
    engine.grant('parent').to('Folder:specs').on('Document:rfc');
    engine.grant('owner').to('User:alice').on('Document:rfc');
    engine.grant('banned').to('User:alice').on('Document:rfc');
    engine.grant('viewer').to('User:*').on('Document:public');

    expect(engine.for('User:bob').can('view').on('Document:rfc')).toBe(true);
    expect(engine.for('User:bob').can('edit').on('Document:rfc')).toBe(false);
    // alice owns the document but is banned from viewing it; edit is not affected by the exclusion
    expect(engine.for('User:alice').can('edit').on('Document:rfc')).toBe(true);
    expect(engine.for('User:alice').can('view').on('Document:rfc')).toBe(false);
    expect(engine.for('User:anyone').can('view').on('Document:public')).toBe(true);
    expect(engine.for('User:anyone').can('view').on('Document:rfc')).toBe(false);

    // bob also sees the public document through the User:* wildcard
    expect(engine.for('User:bob').listAccessible('Document')).toEqual([
      { object: 'Document:rfc', actions: ['view'] },
      { object: 'Document:public', actions: ['view'] },
    ]);
    expect(engine.for('User:carol').listAccessible('Document')).toEqual([{ object: 'Document:public', actions: ['view'] }]);
  });

  it('revoking a nested group membership removes inherited access', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 60_000 });
    engine.grant('member').to('User:bob').on('Group:backend');
    engine.grant('member').to('Group:backend#member').on('Group:eng');
    engine.grant('editor').to('Group:eng#member').on('Document:1');

    expect(engine.for('User:bob').can('edit').on('Document:1')).toBe(true);
    engine.revoke('member').from('Group:backend#member').on('Group:eng');
    expect(engine.for('User:bob').can('edit').on('Document:1')).toBe(false);
  });

  it('traces expression nodes', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:1');
    const { allowed, trace } = engine.for('User:alice').check('edit').on('Document:1');
    expect(allowed).toBe(true);
    expect(trace).toContainEqual({ path: 'owner', target: 'Document:1', found: true, subjects: ['User:alice'] });
  });
});

describe('Schema validation', () => {
  const build = (definition: any) => () =>
    new ZanzoEngine(new ZanzoBuilder().entity('User', { actions: [], relations: {} }).entity('Doc', definition).build());

  it('rejects permissions that reference themselves without an arrow', () => {
    expect(build({ relations: { owner: 'User' }, permissions: { a: 'owner | b', b: 'a' } })).toThrow(/references itself: a → b → a/);
  });

  it('rejects expression syntax errors', () => {
    try {
      build({ relations: { owner: 'User' }, permissions: { view: 'owner |' } })();
      expect.fail('expected a schema error');
    } catch (error) {
      expect(error).toBeInstanceOf(ZanzoError);
      expect((error as ZanzoError).code).toBe(ZanzoErrorCode.INVALID_SCHEMA);
    }
  });

  it('rejects usersets that point to undefined relations', () => {
    const invalid = () =>
      new ZanzoEngine(
        new ZanzoBuilder()
          .entity('User', { actions: [], relations: {} })
          .entity('Group', { relations: { member: 'User' }, permissions: {} })
          .entity('Doc', { relations: { viewer: ['Group#members'] }, permissions: { view: 'viewer' } })
          .build(),
      );
    expect(invalid).toThrow(/"members" is not defined on "Group"/);
  });

  it('rejects arrows to names missing on every subject type', () => {
    const invalid = () =>
      new ZanzoEngine(
        new ZanzoBuilder()
          .entity('User', { actions: [], relations: {} })
          .entity('Folder', { relations: { viewer: 'User' }, permissions: { view: 'viewer' } })
          .entity('Doc', { relations: { parent: 'Folder' }, permissions: { view: 'parent->edit' } })
          .build(),
      );
    expect(invalid).toThrow(ZanzoError);
  });
});

describe('SQL query AST from the IR', () => {
  it('inlines computed permissions into relation paths', () => {
    const engine = new ZanzoEngine(
      new ZanzoBuilder()
        .entity('User', { actions: [], relations: {} })
        .entity('Workspace', { relations: { admin: 'User' }, permissions: { manage: 'admin' } })
        .entity('Doc', {
          relations: { workspace: 'Workspace', owner: 'User' },
          permissions: { edit: 'owner | workspace->manage', view: 'edit' },
        })
        .build(),
    );
    const ast = engine.buildDatabaseQuery('User:1', 'view', 'Doc');
    expect(ast?.conditions.map((c) => (c.type === 'direct' ? c.relation : [c.relation, ...c.nextRelationPath].join('.')))).toEqual([
      'owner',
      'workspace.admin',
    ]);
  });

  it('reports features the SQL adapter cannot evaluate yet', () => {
    const engine = new ZanzoEngine(schema);
    expect(() => engine.buildDatabaseQuery('User:1', 'view', 'Document')).toThrow(
      expect.objectContaining({ code: ZanzoErrorCode.UNSUPPORTED_FEATURE }),
    );
    expect(engine.buildDatabaseQuery('User:1', 'delete', 'Document')?.conditions).toHaveLength(1);
  });
});

describe('Lookups, Expand and Read', () => {
  const build = () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('member').to('User:bob').on('Group:eng');
    engine.grant('viewer').to('Group:eng#member').on('Folder:root');
    engine.grant('parent').to('Folder:root').on('Document:rfc');
    engine.grant('owner').to('User:alice').on('Document:rfc');
    engine.grant('viewer').to('User:temp').on('Document:rfc').until(new Date(Date.now() - 1000));
    return engine;
  };

  it('lookupResources lists what an actor can access', () => {
    const engine = build();
    expect(engine.lookupResources('User:bob', 'view', 'Document')).toEqual(['Document:rfc']);
    expect(engine.lookupResources('User:bob', 'edit', 'Document')).toEqual([]);
  });

  it('lookupSubjects lists who can access, ignoring expired tuples', () => {
    const engine = build();
    expect(engine.lookupSubjects('Document:rfc', 'view', 'User')).toEqual({
      subjects: ['User:alice', 'User:bob'],
      wildcard: false,
      excluded: [],
    });
  });

  it('expand returns the rule tree with direct subjects at the leaves', () => {
    const engine = build();
    const tree = engine.expand('Document:rfc', 'edit');
    expect(tree).toEqual({
      type: 'union',
      children: [
        { type: 'leaf', object: 'Document:rfc', relation: 'owner', subjects: ['User:alice'] },
        { type: 'leaf', object: 'Document:rfc', relation: 'editor', subjects: [] },
      ],
    });

    const view = engine.expand('Document:rfc', 'view');
    expect(view?.type).toBe('exclusion');
    // The inherited branch walks parent → Folder:root#view, whose viewer is the unexpanded userset
    expect(JSON.stringify(view)).toContain('"subjects":["Group:eng#member"]');
  });

  it('read filters stored tuples and reports expirations', () => {
    const engine = build();
    expect(engine.read({ object: 'Document:rfc', relation: 'owner' })).toEqual([
      { subject: 'User:alice', relation: 'owner', object: 'Document:rfc' },
    ]);
    expect(engine.read({ subject: 'Group:eng#member' })).toEqual([
      { subject: 'Group:eng#member', relation: 'viewer', object: 'Folder:root' },
    ]);
    const expired = engine.read({ subject: 'User:temp' });
    expect(expired).toHaveLength(1);
    expect(expired[0]!.expiresAt).toBeInstanceOf(Date);
    expect(engine.read()).toHaveLength(5);
    expect(engine.read({ relation: 'unknown' })).toEqual([]);
  });
});

describe('Conditions and contextual tuples', () => {
  const conditions = {
    ip_allowlist: (context: Record<string, unknown>) =>
      Array.isArray(context['allowed']) && context['allowed'].includes(context['ip']),
    business_hours: (context: Record<string, unknown>) => {
      const hour = context['hour'];
      return typeof hour === 'number' && hour >= 9 && hour < 18;
    },
  };

  it('grants through a conditional tuple only when the condition holds', () => {
    const engine = new ZanzoEngine(schema, { conditions });
    engine.enableCache({ ttlMs: 60_000 });
    engine.grant('viewer').to('User:bob').on('Document:1').when('ip_allowlist', { allowed: ['10.0.0.7'] });

    expect(engine.for('User:bob').can('view').on('Document:1', { context: { ip: '10.0.0.7' } })).toBe(true);
    expect(engine.for('User:bob').can('view').on('Document:1', { context: { ip: '1.2.3.4' } })).toBe(false);
    // Without context the condition sees no ip: denied, and this result may be cached
    expect(engine.for('User:bob').can('view').on('Document:1')).toBe(false);
    // A later request with the right context is not served the cached denial
    expect(engine.for('User:bob').can('view').on('Document:1', { context: { ip: '10.0.0.7' } })).toBe(true);
  });

  it('round-trips conditions through read() and load()', () => {
    const engine = new ZanzoEngine(schema, { conditions });
    engine.grant('viewer').to('User:bob').on('Document:1').when('business_hours');
    const [stored] = engine.read({ object: 'Document:1' });
    expect(stored).toEqual({ subject: 'User:bob', relation: 'viewer', object: 'Document:1', condition: { name: 'business_hours' } });

    const copy = new ZanzoEngine(schema, { conditions });
    copy.load([stored!]);
    expect(copy.for('User:bob').can('view').on('Document:1', { context: { hour: 10 } })).toBe(true);
    expect(copy.for('User:bob').can('view').on('Document:1', { context: { hour: 22 } })).toBe(false);
  });

  it('rejects tuples with unregistered conditions', () => {
    const engine = new ZanzoEngine(schema, { conditions });
    expect(() => engine.grant('viewer').to('User:bob').on('Document:1').when('unknown')).toThrow(
      expect.objectContaining({ code: ZanzoErrorCode.INVALID_CONDITION }),
    );
  });

  it('applies contextual tuples to one request without storing or caching them', () => {
    const engine = new ZanzoEngine(schema, { conditions });
    engine.enableCache({ ttlMs: 60_000 });
    engine.grant('parent').to('Folder:shared').on('Document:1');
    const revision = engine.revision;
    const contextualTuples = [{ subject: 'User:guest', relation: 'viewer', object: 'Folder:shared' }];

    expect(engine.for('User:guest').can('view').on('Document:1', { contextualTuples })).toBe(true);
    expect(engine.lookupResources('User:guest', 'view', 'Document', { contextualTuples })).toEqual(['Document:1']);
    expect(engine.lookupSubjects('Document:1', 'view', 'User', { contextualTuples }).subjects).toEqual(['User:guest']);
    expect(engine.for('User:guest').check('view').on('Document:1', { contextualTuples }).allowed).toBe(true);

    expect(engine.for('User:guest').can('view').on('Document:1')).toBe(false);
    expect(engine.read({ subject: 'User:guest' })).toEqual([]);
    expect(engine.revision).toBe(revision);
  });

  it('a contextual copy of a stored conditional tuple applies in addition to it', () => {
    const engine = new ZanzoEngine(schema, { conditions });
    engine.grant('viewer').to('User:bob').on('Document:1').when('ip_allowlist', { allowed: ['10.0.0.7'] });
    const options = {
      context: { ip: '1.2.3.4', hour: 10 },
      contextualTuples: [
        { subject: 'User:bob', relation: 'viewer', object: 'Document:1', condition: { name: 'ip_allowlist', context: { allowed: [] } } },
        { subject: 'User:bob', relation: 'viewer', object: 'Document:1', condition: { name: 'business_hours' } },
      ],
    };
    // The stored condition fails for this ip, the first copy fails, the second holds
    expect(engine.for('User:bob').can('view').on('Document:1', options)).toBe(true);
    expect(engine.for('User:bob').can('view').on('Document:1', { ...options, context: { ip: '1.2.3.4', hour: 22 } })).toBe(false);
    // Stored metadata is intact afterwards
    expect(engine.read({ object: 'Document:1' })[0]!.condition).toEqual({ name: 'ip_allowlist', context: { allowed: ['10.0.0.7'] } });
  });
});
