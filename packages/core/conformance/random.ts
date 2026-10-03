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
