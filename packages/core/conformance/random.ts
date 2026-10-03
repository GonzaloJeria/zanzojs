import type { NeutralSchema, NeutralTuple } from './model';

/** Small deterministic PRNG (mulberry32), so failures are reproducible from the seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    chance: (p: number) => next() < p,
  };
}

export type Rng = ReturnType<typeof rng>;

export interface RandomWorld {
  schema: NeutralSchema;
  tuples: NeutralTuple[];
  users: string[];
  /** Every (object, permission) pair worth querying */
  targets: Array<[object: string, permission: string]>;
  /** Tuples that can be written: [object, relation, subjectCandidates] */
  writable: Array<[object: string, relation: string, subjects: string[]]>;
}

/**
 * Generates a random schema restricted to features the current engine supports
 * (unions of relations, computed usersets and tuple-to-userset over single-typed
 * relations) plus random data with cycles, diamonds and expired tuples.
 */
export function randomWorld(r: Rng, now: number): RandomWorld {
  const types = ['A', 'B', 'C'].slice(0, 2 + r.int(2));
  const schema: NeutralSchema = { User: {} };
  const relationsOf: Record<string, Record<string, string>> = {};

  for (const type of types) {
    const relations: Record<string, string> = {};
    const count = 1 + r.int(3);
    for (let i = 0; i < count; i++) {
      // Relations point to users or to other (possibly the same) types: cycles are allowed
      relations[`r${i}`] = r.chance(0.5) ? 'User' : r.pick(types);
    }
    relationsOf[type] = relations;
  }

  // Permissions are defined bottom-up in type order and may only reference permissions of
  // earlier types or earlier permissions of the same type, so no permission is recursive.
  const permissionsOf: Record<string, string[]> = {};
  types.forEach((type, typeIndex) => {
    const permissions: Record<string, string> = {};
    const names: string[] = [];
    const permCount = 1 + r.int(2);
    for (let p = 0; p < permCount; p++) {
      const terms = new Set<string>();
      const termCount = 1 + r.int(3);
      for (let t = 0; t < termCount; t++) {
        const relation = r.pick(Object.keys(relationsOf[type]!));
        const target = relationsOf[type]![relation]!;
        const roll = r.next();
        if (roll < 0.45 || target === 'User') {
          terms.add(relation);
        } else if (roll < 0.6 && names.length > 0) {
          terms.add(r.pick(names));
        } else {
          const targetIndex = types.indexOf(target);
          const targetChoices = [
            ...Object.keys(relationsOf[target]!),
            ...(targetIndex < typeIndex ? (permissionsOf[target] ?? []) : []),
          ];
          terms.add(`${relation}->${r.pick(targetChoices)}`);
        }
      }
      const name = `p${p}`;
      permissions[name] = [...terms].join(' | ');
      names.push(name);
    }
    permissionsOf[type] = names;
    schema[type] = {
      relations: Object.fromEntries(Object.entries(relationsOf[type]!).map(([k, v]) => [k, [v]])),
      permissions,
    };
  });

  const users = ['User:u0', 'User:u1', 'User:u2', 'User:u3'];
  const objectsOf = (type: string) => (type === 'User' ? users : [0, 1, 2].map((i) => `${type}:${type.toLowerCase()}${i}`));

  const tuples: NeutralTuple[] = [];
  const writable: RandomWorld['writable'] = [];
  const seen = new Set<string>();
  for (const type of types) {
    for (const object of objectsOf(type)) {
      for (const [relation, target] of Object.entries(relationsOf[type]!)) {
        const candidates = objectsOf(target).filter((s) => s !== object);
        writable.push([object, relation, candidates]);
        for (const subject of candidates) {
          if (!r.chance(0.3)) continue;
          const key = `${object}|${relation}|${subject}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const tuple: NeutralTuple = { object, relation, subject };
          if (r.chance(0.15)) tuple.expiresAt = r.chance(0.5) ? now - 60_000 : now + 3_600_000;
          tuples.push(tuple);
        }
      }
    }
  }

  const targets: RandomWorld['targets'] = [];
  for (const type of types) {
    for (const object of objectsOf(type)) {
      for (const permission of permissionsOf[type]!) targets.push([object, permission]);
    }
  }

  return { schema, tuples, users, targets, writable };
}

/**
 * Generates a random world over the full model: relations with several subject types,
 * usersets (nested and cyclic groups), public wildcards, intersections, exclusions and
 * recursive tuple-to-userset permissions.
 */
export function randomFullWorld(r: Rng, now: number): RandomWorld {
  const types = ['A', 'B', 'C'].slice(0, 2 + r.int(2));
  const schema: NeutralSchema = {
    User: {},
    Group: { relations: { member: ['User', 'Group#member'] } },
  };
  const subjectChoices = ['User', 'User:*', 'Group#member', ...types];
  const relationsOf: Record<string, Record<string, string[]>> = {};

  for (const type of types) {
    const relations: Record<string, string[]> = {};
    const count = 2 + r.int(3);
    for (let i = 0; i < count; i++) {
      const allowed = new Set<string>([r.pick(subjectChoices)]);
      if (r.chance(0.4)) allowed.add(r.pick(subjectChoices));
      relations[`r${i}`] = [...allowed];
    }
    // Always keep one plain user relation, used by exclusions
    relations['banned'] = ['User'];
    relationsOf[type] = relations;
  }

  const permissionNames = ['p0', 'p1', 'p2'];
  const countOf: Record<string, number> = Object.fromEntries(types.map((t) => [t, 1 + r.int(3)]));

  for (const type of types) {
    const relations = relationsOf[type]!;
    const relationNames = Object.keys(relations).filter((n) => n !== 'banned');
    const permissions: Record<string, string> = {};

    for (let p = 0; p < countOf[type]!; p++) {
      const term = (): string => {
        const relation = r.pick(relationNames);
        const concrete = relations[relation]!.filter((s) => types.includes(s));
        const roll = r.next();
        if (roll < 0.35 || concrete.length === 0) return relation;
        if (roll < 0.5 && p > 0) return `p${r.int(p)}`; // earlier permission: no computed cycles
        // Arrow to any relation or permission of the target type, including recursion
        const target = r.pick(concrete);
        const targetNames = [...Object.keys(relationsOf[target]!), ...permissionNames.slice(0, countOf[target]!)];
        return `${relation}->${r.pick(targetNames)}`;
      };

      const terms = Array.from({ length: 1 + r.int(3) }, term);
      let expression = terms.join(r.chance(0.25) ? ' & ' : ' | ');
      if (r.chance(0.25)) expression = `(${expression}) - banned`;
      permissions[`p${p}`] = expression;
    }

    schema[type] = { relations, permissions };
  }

  const users = ['User:u0', 'User:u1', 'User:u2', 'User:u3'];
  const groups = ['Group:g0', 'Group:g1', 'Group:g2'];
  const objectsOf = (type: string) => [0, 1, 2].map((i) => `${type}:${type.toLowerCase()}${i}`);
  const candidatesFor = (spec: string): string[] => {
    if (spec === 'User') return users;
    if (spec === 'User:*') return ['User:*'];
    if (spec === 'Group#member') return groups.map((g) => `${g}#member`);
    return objectsOf(spec);
  };

  const tuples: NeutralTuple[] = [];
  const writable: RandomWorld['writable'] = [];
  const seen = new Set<string>();
  const add = (object: string, relation: string, subject: string) => {
    const key = `${object}|${relation}|${subject}`;
    if (seen.has(key) || subject === object) return;
    seen.add(key);
    const tuple: NeutralTuple = { object, relation, subject };
    if (r.chance(0.1)) tuple.expiresAt = r.chance(0.5) ? now - 60_000 : now + 3_600_000;
    tuples.push(tuple);
  };

  // Group membership, including nested and cyclic groups
  for (const group of groups) {
    const candidates = [...users, ...groups.filter((g) => g !== group).map((g) => `${g}#member`)];
    writable.push([group, 'member', candidates]);
    for (const subject of candidates) if (r.chance(0.3)) add(group, 'member', subject);
  }

  for (const type of types) {
    for (const object of objectsOf(type)) {
      for (const [relation, allowed] of Object.entries(relationsOf[type]!)) {
        const candidates = allowed.flatMap(candidatesFor).filter((s) => s !== object);
        writable.push([object, relation, candidates]);
        for (const subject of candidates) if (r.chance(subject === 'User:*' ? 0.15 : 0.25)) add(object, relation, subject);
      }
    }
  }

  const targets: RandomWorld['targets'] = [];
  for (const type of types) {
    for (const object of objectsOf(type)) {
      for (const permission of Object.keys(schema[type]!.permissions!)) targets.push([object, permission]);
    }
  }

  return { schema, tuples, users, targets, writable };
}
