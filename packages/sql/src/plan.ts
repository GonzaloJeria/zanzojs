import { compileSchema, type AllowedSubject, type CompiledSchema, type Node } from '@zanzojs/core/schema';
import type { SchemaData } from '@zanzojs/core';

/**
 * What the loaders need to know about a schema: which relations a permission can reach,
 * which relations are followed by arrows, and which usersets can appear as subjects.
 */
export class SchemaPlan {
  readonly compiled: CompiledSchema;
  /** Relations used as the left side of an arrow, per type: their subjects are traversed */
  readonly tuplesets = new Map<string, Set<string>>();
  /** Types that are the subject of some tupleset: they are parents in the graph */
  readonly parentTypes = new Set<string>();
  /** `Type#relation` usersets accepted by some relation */
  readonly usersets = new Set<string>();
  private readonly neededCache = new Map<string, ReadonlyMap<string, ReadonlySet<string>>>();

  constructor(schema: SchemaData) {
    this.compiled = compileSchema(schema);
    for (const type of this.compiled.types.values()) {
      for (const subjects of type.relations.values()) {
        for (const s of subjects) if (s.relation !== undefined) this.usersets.add(`${s.type}#${s.relation}`);
      }
      for (const node of type.permissions.values()) this.collectArrows(type.name, node);
    }
  }

  private collectArrows(type: string, node: Node): void {
    switch (node.kind) {
      case 'name':
        return;
      case 'arrow': {
        let set = this.tuplesets.get(type);
        if (!set) this.tuplesets.set(type, (set = new Set()));
        set.add(node.tupleset);
        for (const s of this.allowed(type, node.tupleset)) if (!s.wildcard) this.parentTypes.add(s.type);
        return;
      }
      case 'union':
      case 'intersection':
        for (const child of node.children) this.collectArrows(type, child);
        return;
      case 'exclusion':
        this.collectArrows(type, node.base);
        this.collectArrows(type, node.subtract);
        return;
    }
  }

  allowed(type: string, relation: string): readonly AllowedSubject[] {
    return this.compiled.types.get(type)?.relations.get(relation) ?? [];
  }

  isTupleset(type: string, relation: string): boolean {
    return this.tuplesets.get(type)?.has(relation) ?? false;
  }

  /**
   * Every relation, per type, that evaluating `name` on `type` can read. Loading only these
   * keeps checks from reading unrelated tuples such as audit or ownership metadata.
   */
  needed(type: string, name: string): ReadonlyMap<string, ReadonlySet<string>> {
    const key = `${type}#${name}`;
    let result = this.neededCache.get(key);
    if (!result) {
      const acc = new Map<string, Set<string>>();
      this.visitName(type, name, acc, new Set());
      this.neededCache.set(key, (result = acc));
    }
    return result;
  }

  /** Union of `needed` for several names on the same type. */
  neededAll(type: string, names: Iterable<string>): ReadonlyMap<string, ReadonlySet<string>> {
    const acc = new Map<string, Set<string>>();
    for (const name of names) {
      for (const [t, relations] of this.needed(type, name)) {
        let set = acc.get(t);
        if (!set) acc.set(t, (set = new Set()));
        for (const r of relations) set.add(r);
      }
    }
    return acc;
  }

  private visitName(type: string, name: string, acc: Map<string, Set<string>>, seen: Set<string>): void {
    const key = `${type}#${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const compiled = this.compiled.types.get(type);
    if (!compiled) return;
    const subjects = compiled.relations.get(name);
    if (subjects) {
      let set = acc.get(type);
      if (!set) acc.set(type, (set = new Set()));
      set.add(name);
      for (const s of subjects) if (s.relation !== undefined) this.visitName(s.type, s.relation, acc, seen);
      return;
    }
    const permission = compiled.permissions.get(name);
    if (permission) this.visitNode(type, permission, acc, seen);
  }

  private visitNode(type: string, node: Node, acc: Map<string, Set<string>>, seen: Set<string>): void {
    switch (node.kind) {
      case 'name':
        return this.visitName(type, node.name, acc, seen);
      case 'arrow':
        this.visitName(type, node.tupleset, acc, seen);
        for (const s of this.allowed(type, node.tupleset)) if (!s.wildcard) this.visitNode(s.type, node.then, acc, seen);
        return;
      case 'union':
      case 'intersection':
        for (const child of node.children) this.visitNode(type, child, acc, seen);
        return;
      case 'exclusion':
        this.visitNode(type, node.base, acc, seen);
        this.visitNode(type, node.subtract, acc, seen);
        return;
    }
  }
}

export const typeOf = (ref: string): string => {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(0, colon);
};
