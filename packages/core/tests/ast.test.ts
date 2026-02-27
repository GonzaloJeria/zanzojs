import { describe, it, expect, beforeEach } from 'vitest';
import { ZanzoBuilder } from '../src/builder/index';
import { ZanzoEngine } from '../src/engine/index';
import type { QueryAST } from '../src/ast/index';

describe('ZanzoEngine - AST Query Pushdown', () => {
  const schema = new ZanzoBuilder()
    .entity('User', { actions: [] as const })
    .entity('Team', {
      actions: [] as const,
      relations: { member: 'User' } as const,
    })
    .entity('Project', {
      actions: ['view', 'edit', 'delete'] as const,
      relations: { owner: 'User', creator: 'User', team: 'Team' } as const,
      permissions: {
        view: ['owner', 'creator', 'team.member'],
        edit: ['owner', 'team.member'], // A nested relation and a direct relation
        delete: [], // Nobody can delete physically via this policy natively
      } as const,
    })
    .build();

  let engine: ZanzoEngine<typeof schema>;

  beforeEach(() => {
    engine = new ZanzoEngine(schema);
  });

  it('should generate null if the action has no valid permissions or relations mapped', () => {
    const ast = engine.buildDatabaseQuery('User:1', 'delete', 'Project');
    expect(ast).toBeNull();
  });

  it('should correctly build AST for single and nested properties combined (OR operation)', () => {
    const ast = engine.buildDatabaseQuery('User:1', 'edit', 'Project');

    const expectedAST: QueryAST = {
      operator: 'OR',
      conditions: [
        {
          type: 'direct',
          relation: 'owner',
          targetSubject: 'User:1',
        },
        {
          type: 'nested',
          relation: 'team',
          nextRelationPath: ['member'],
          targetSubject: 'User:1',
        },
      ],
    };

    expect(ast).toEqual(expectedAST);
  });

  it('should correctly build AST for multiple properties (flat lists)', () => {
    const ast = engine.buildDatabaseQuery('User:Carlos', 'view', 'Project');

    const expectedAST: QueryAST = {
      operator: 'OR',
      conditions: [
        {
          type: 'direct',
          relation: 'owner',
          targetSubject: 'User:Carlos',
        },
        {
          type: 'direct',
          relation: 'creator',
          targetSubject: 'User:Carlos',
        },
        {
          type: 'nested',
          relation: 'team',
          nextRelationPath: ['member'],
          targetSubject: 'User:Carlos',
        },
      ],
    };

    expect(ast).toEqual(expectedAST);
  });

  it('should fail compilation if checking an invalid resource/action combination via Typescript', () => {
    // Both tests below should highlight compiler errors but skip runtime checking via type exceptions
    // @ts-expect-error
    engine.buildDatabaseQuery('User:X', 'view', 'NonExistent');

    // @ts-expect-error
    engine.buildDatabaseQuery('User:X', 'read', 'Project');
  });
});
