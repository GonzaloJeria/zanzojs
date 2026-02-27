import { describe, it, expect } from 'vitest';
import { ZanzoBuilder } from '../src/builder/index';
import { ZanzoEngine } from '../src/engine/index';
import { createZanzoSnapshot } from '../src/compiler/index';
import { ZanzoClient } from '../src/client/index';

describe('ReBAC Client & Compiler', () => {
  const schema = new ZanzoBuilder()
    .entity('User', { actions: [] as const })
    .entity('Team', {
      actions: [] as const,
      relations: { member: 'User' } as const,
    })
    .entity('Project', {
      actions: ['view', 'edit', 'delete'] as const,
      relations: { owner: 'User', team: 'Team' } as const,
      permissions: {
        view: ['owner', 'team.member'],
        edit: ['owner'],
        delete: ['owner'],
      } as const,
    })
    .build();

  it('should compile a flat JSON mapping from the complex graph engine', () => {
    const engine = new ZanzoEngine(schema);

    // Setup typical graph relations
    engine.addTuple({ subject: 'User:1', relation: 'owner', object: 'Project:A' });
    engine.addTuple({ subject: 'User:2', relation: 'member', object: 'Team:Devs' });
    engine.addTuple({ subject: 'Team:Devs', relation: 'team', object: 'Project:A' });
    engine.addTuple({ subject: 'Team:Devs', relation: 'team', object: 'Project:B' });

    // User:1 is direct owner of Project:A
    const compiledUser1 = createZanzoSnapshot(engine, 'User:1');
    expect(compiledUser1).toEqual({
      'Project:A': ['view', 'edit', 'delete'],
    });

    // User:2 is inherited viewer of Project:A and Project:B via Team
    const compiledUser2 = createZanzoSnapshot(engine, 'User:2');
    expect(compiledUser2).toEqual({
      'Project:A': ['view'],
      'Project:B': ['view'],
    });

    // User:3 has no relations
    const compiledUser3 = createZanzoSnapshot(engine, 'User:3');
    expect(compiledUser3).toEqual({});
  });

  it('should allow the Client to evaluate permissions in O(1) strictly from the flat JSON mask', () => {
    // We simulate receiving this JSON from an API endpoint over network in a React/Vue App
    const networkResponseJSON = {
      'Project:A': ['view'],
      'Project:B': ['view', 'edit'],
    };

    // Instantiate lightweight client (Zero dependency to Engine/Graph)
    const client = new ZanzoClient(networkResponseJSON as any);

    // Assert fast O(1) verifications
    expect(client.can('view', 'Project:A')).toBe(true);
    expect(client.can('edit', 'Project:A')).toBe(false);

    expect(client.can('view', 'Project:B')).toBe(true);
    expect(client.can('edit', 'Project:B')).toBe(true);
    expect(client.can('delete', 'Project:B')).toBe(false);

    // Assert fail-safe on unmapped resources
    expect(client.can('view', 'Project:C')).toBe(false);

    // Verify snapshot state matches the network payload
    expect(client.getSnapshot()).toEqual(networkResponseJSON);
  });
});
