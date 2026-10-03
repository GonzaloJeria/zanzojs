import { describe, it, expect, beforeEach } from 'vitest';
import { ZanzoBuilder, ZanzoEngine } from '../src/index';

describe('Zanzo Core Security Audit', () => {
  let engine: ZanzoEngine<any>;

  beforeEach(() => {
    // 1. Setup a cyclical schema
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Node', {
        actions: ['read'],
        relations: { parent: 'Node', owner: 'User' },
        permissions: { read: ['owner', 'parent.owner'] }
      })
      .build();

    engine = new ZanzoEngine(schema);
  });

  it('should not throw Maximum Call Stack Size Exceeded on cyclic graphs, but safely abort using Set signatures', () => {
    // Inject a vicious infinite cycle: Node:A parent of Node:B, Node:B parent of Node:A
    engine.addTuples([
      { subject: 'Node:B', relation: 'parent', object: 'Node:A' },
      { subject: 'Node:A', relation: 'parent', object: 'Node:B' },
    ]);

    // Request evaluation that triggers the exploration
    // It should hit the Cycle Detection mechanism and return false, without Stack Overflow
    const result = engine.can('User:99', 'read', 'Node:A');
    expect(result).toBe(false);
  });

  it('should enforce Max Depth Threshold (50) and throw a controlled Security Exception on artificially deep nested chains', () => {
    // A schema path with more than 50 hops must abort with a controlled exception
    const deepPath = [...new Array(51).fill('parent'), 'owner'].join('.');
    const deepSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Node', {
        actions: ['read'],
        relations: { parent: 'Node', owner: 'User' },
        permissions: { read: [deepPath as 'owner'] }
      })
      .build();
    const deepEngine = new ZanzoEngine(deepSchema);

    const nodes = Array.from({ length: 55 }, (_, i) => `Node:${i}`);
    for (let i = 0; i < 52; i++) {
      deepEngine.addTuple({ subject: nodes[i + 1]!, relation: 'parent', object: nodes[i]! });
    }
    deepEngine.addTuple({ subject: 'User:99', relation: 'owner', object: nodes[52]! });

    expect(() => deepEngine.can('User:99', 'read', 'Node:0'))
      .toThrow(/Security Exception: Maximum relationship depth of 50 exceeded/);
  });
  
  it('should immediately intercept poisoning attacks (Null byte injections or monstrous payloads)', () => {
    const maliciousActor = "User:Inject\x00"; // Null byte control char
    const overSizedActor = "a".repeat(256);
    
    expect(() => engine.can(maliciousActor, 'read', 'Node:A'))
      .toThrow(/unprintable control characters/);
      
    expect(() => engine.can(overSizedActor, 'read', 'Node:A'))
      .toThrow(/under 255 characters/);
  });
});
