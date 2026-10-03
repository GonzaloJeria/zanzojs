/**
 * Compact in-memory tuple store.
 *
 * Strings are interned once into dense integer ids. Tuples are edges stored in parallel
 * typed arrays and threaded into two doubly linked lists:
 * - forward: every edge of an object (object → relation → subject), for checks;
 * - reverse: every edge whose subject refers to a node (subject → object), for lookups
 *   and cache invalidation. Usersets (`Group:eng#member`) are threaded under their object
 *   (`Group:eng`), wildcards (`User:*`) under themselves.
 *
 * Objects with many subjects (large groups, organizations) also get a hash overlay so
 * membership stays O(1). Removal is O(1) once the edge is found.
 *
 * @internal Not part of the public API.
 */

export const NONE = -1;

export const KIND_OBJECT = 0;
export const KIND_USERSET = 1;
export const KIND_WILDCARD = 2;

/** Above this many edges, an object gets a hash overlay for O(1) membership. */
const LARGE_OBJECT = 32;

/** Interns strings into dense ids. */
export class SymbolTable {
  private readonly ids = new Map<string, number>();
  readonly values: string[] = [];

  get(value: string): number | undefined {
    return this.ids.get(value);
  }

  intern(value: string): number {
    let id = this.ids.get(value);
    if (id === undefined) {
      id = this.values.length;
      this.ids.set(value, id);
      this.values.push(value);
    }
    return id;
  }

  get size(): number {
    return this.values.length;
  }
}

/** Edges of one relation of a large object: subject id → edge, plus its indirect subjects. */
interface LargeRelation {
  subjects: Map<number, number>;
  indirect: Set<number>;
}

/** Entity types and relation names are stored in 16 bits. */
const MAX_SYMBOLS = 0xffff;

function grow<T extends Int32Array | Uint16Array | Uint8Array>(array: T, minLength: number, fill?: number): T {
  if (array.length >= minLength) return array;
  let length = Math.max(array.length * 2, 16);
  while (length < minLength) length *= 2;
  const next = new (array.constructor as new (n: number) => T)(length);
  next.set(array);
  if (fill !== undefined) next.fill(fill, array.length);
  return next;
}

export class MemoryTupleStore {
  /** Relation and permission names */
  readonly names = new SymbolTable();
  /** Entity types */
  types = new SymbolTable();
  /** Objects, subjects, usersets and wildcards */
  entities = new SymbolTable();

  // ── Per entity ──
  /** Type id; for a wildcard (`User:*`), the type it matches */
  entityType = new Uint16Array(0);
  kind = new Uint8Array(0);
  forwardHead = new Int32Array(0);
  reverseHead = new Int32Array(0);
  /** Edges per object, saturating at 255: only compared with LARGE_OBJECT */
  private forwardCount = new Uint8Array(0);
  /** Usersets are rare: object id (`Group:eng`) and relation name id (`member`) by userset id */
  private readonly usersetObjects = new Map<number, number>();
  private readonly usersetNames = new Map<number, number>();

  // ── Per edge ──
  edgeObject = new Int32Array(0);
  edgeRelation = new Uint16Array(0);
  edgeSubject = new Int32Array(0);
  forwardNext = new Int32Array(0);
  private forwardPrev = new Int32Array(0);
  reverseNext = new Int32Array(0);
  private reversePrev = new Int32Array(0);
  private edgeHighWater = 0;
  private freeEdge = NONE;
  private liveEdges = 0;

  /** Expiration in epoch milliseconds, only for edges that expire */
  readonly expiry = new Map<number, number>();
  /** Caveats, only for conditional edges */
  readonly conditions = new Map<number, { name: string; context?: Record<string, unknown> }>();
  /** Hash overlay for objects with many edges: object → relation → LargeRelation */
  private readonly large = new Map<number, Map<number, LargeRelation>>();

  /** Incremented on every mutation */
  revision = 0;

  get size(): number {
    return this.liveEdges;
  }

  /** Interns an entity reference (`Type:id`, `Type:id#relation` or `Type:*`). */
  intern(ref: string): number {
    const existing = this.entities.get(ref);
    if (existing !== undefined) return existing;

    const id = this.entities.intern(ref);
    const capacity = id + 1;
    this.entityType = grow(this.entityType, capacity);
    this.kind = grow(this.kind, capacity);
    this.forwardHead = grow(this.forwardHead, capacity, NONE);
    this.reverseHead = grow(this.reverseHead, capacity, NONE);
    this.forwardCount = grow(this.forwardCount, capacity);

    this.entityType[id] = symbol(this.types, ref.substring(0, ref.indexOf(':')));
    if (ref.endsWith(':*')) {
      this.kind[id] = KIND_WILDCARD;
    } else {
      const hash = ref.indexOf('#');
      if (hash === -1) {
        this.kind[id] = KIND_OBJECT;
      } else {
        this.kind[id] = KIND_USERSET;
        this.usersetObjects.set(id, this.intern(ref.substring(0, hash)));
        this.usersetNames.set(id, symbol(this.names, ref.substring(hash + 1)));
      }
    }
    return id;
  }

  /** Object of a userset (`Group:eng` for `Group:eng#member`). */
  usersetObject(userset: number): number {
    return this.usersetObjects.get(userset)!;
  }

  /** Relation name id of a userset (`member` for `Group:eng#member`). */
  usersetName(userset: number): number {
    return this.usersetNames.get(userset)!;
  }

  /** Interns a relation name, enforcing the 16-bit limit. */
  internName(name: string): number {
    return symbol(this.names, name);
  }

  /** The node a subject is threaded under in the reverse lists. */
  reverseKey(subject: number): number {
    return this.kind[subject] === KIND_USERSET ? this.usersetObjects.get(subject)! : subject;
  }

  /** Edge index of `object#relation@subject`, or NONE. */
  find(object: number, relation: number, subject: number): number {
    const large = this.large.get(object);
    if (large) return large.get(relation)?.subjects.get(subject) ?? NONE;
    for (let e = this.forwardHead[object]!; e !== NONE; e = this.forwardNext[e]!) {
      if (this.edgeSubject[e] === subject && this.edgeRelation[e] === relation) return e;
    }
    return NONE;
  }

  /** Indirect edges (usersets, wildcards) of a large object's relation, or undefined for small objects. */
  largeIndirect(object: number, relation: number): Set<number> | undefined {
    const large = this.large.get(object);
    return large ? (large.get(relation)?.indirect ?? EMPTY) : undefined;
  }

  /** Adds an edge; returns its index and whether it was created. */
  add(object: number, relation: number, subject: number): { edge: number; created: boolean } {
    const existing = this.find(object, relation, subject);
    if (existing !== NONE) return { edge: existing, created: false };

    let e = this.freeEdge;
    if (e !== NONE) {
      this.freeEdge = this.forwardNext[e]!;
    } else {
      e = this.edgeHighWater++;
      const capacity = e + 1;
      this.edgeObject = grow(this.edgeObject, capacity);
      this.edgeRelation = grow(this.edgeRelation, capacity);
      this.edgeSubject = grow(this.edgeSubject, capacity);
      this.forwardNext = grow(this.forwardNext, capacity);
      this.forwardPrev = grow(this.forwardPrev, capacity);
      this.reverseNext = grow(this.reverseNext, capacity);
      this.reversePrev = grow(this.reversePrev, capacity);
    }

    this.edgeObject[e] = object;
    this.edgeRelation[e] = relation;
    this.edgeSubject[e] = subject;

    const head = this.forwardHead[object]!;
    this.forwardNext[e] = head;
    this.forwardPrev[e] = NONE;
    if (head !== NONE) this.forwardPrev[head] = e;
    this.forwardHead[object] = e;

    const key = this.reverseKey(subject);
    const reverseHead = this.reverseHead[key]!;
    this.reverseNext[e] = reverseHead;
    this.reversePrev[e] = NONE;
    if (reverseHead !== NONE) this.reversePrev[reverseHead] = e;
    this.reverseHead[key] = e;

    const count = this.forwardCount[object]! + 1;
    if (count <= 255) this.forwardCount[object] = count;
    const large = this.large.get(object);
    if (large) this.indexLarge(large, e);
    else if (count > LARGE_OBJECT) this.buildLarge(object);

    this.liveEdges++;
    this.revision++;
    return { edge: e, created: true };
  }

  /** Removes an edge by index. */
  removeEdge(e: number): void {
    const object = this.edgeObject[e]!;
    const subject = this.edgeSubject[e]!;

    const next = this.forwardNext[e]!;
    const prev = this.forwardPrev[e]!;
    if (prev !== NONE) this.forwardNext[prev] = next;
    else this.forwardHead[object] = next;
    if (next !== NONE) this.forwardPrev[next] = prev;

    const key = this.reverseKey(subject);
    const reverseNext = this.reverseNext[e]!;
    const reversePrev = this.reversePrev[e]!;
    if (reversePrev !== NONE) this.reverseNext[reversePrev] = reverseNext;
    else this.reverseHead[key] = reverseNext;
    if (reverseNext !== NONE) this.reversePrev[reverseNext] = reversePrev;

    const large = this.large.get(object);
    if (large) {
      const relation = large.get(this.edgeRelation[e]!);
      relation?.subjects.delete(subject);
      relation?.indirect.delete(e);
    }
    // The edge is already unlinked: a saturated counter is recounted from the list
    let count = this.forwardCount[object]!;
    if (count === 255) {
      count = 0;
      for (let f = this.forwardHead[object]!; f !== NONE && count < 255; f = this.forwardNext[f]!) count++;
    } else {
      count--;
    }
    this.forwardCount[object] = count;
    if (large && count <= LARGE_OBJECT / 2) this.large.delete(object);

    this.expiry.delete(e);
    this.conditions.delete(e);
    this.edgeObject[e] = NONE;
    this.forwardNext[e] = this.freeEdge;
    this.freeEdge = e;
    this.liveEdges--;
    this.revision++;
  }

  /** Sets or clears the expiration (epoch ms) of an edge. */
  setExpiry(e: number, expiresAt: number | undefined): void {
    if (expiresAt === undefined) {
      if (this.expiry.delete(e)) this.revision++;
    } else if (this.expiry.get(e) !== expiresAt) {
      this.expiry.set(e, expiresAt);
      this.revision++;
    }
  }

  /**
   * Releases spare capacity of the typed arrays (they double when growing).
   * Called after bulk loads, when the store is unlikely to grow much further.
   */
  trim(): void {
    const entities = this.entities.size;
    const edges = this.edgeHighWater;
    this.entityType = this.entityType.slice(0, entities);
    this.kind = this.kind.slice(0, entities);
    this.forwardHead = this.forwardHead.slice(0, entities);
    this.reverseHead = this.reverseHead.slice(0, entities);
    this.forwardCount = this.forwardCount.slice(0, entities);
    this.edgeObject = this.edgeObject.slice(0, edges);
    this.edgeRelation = this.edgeRelation.slice(0, edges);
    this.edgeSubject = this.edgeSubject.slice(0, edges);
    this.forwardNext = this.forwardNext.slice(0, edges);
    this.forwardPrev = this.forwardPrev.slice(0, edges);
    this.reverseNext = this.reverseNext.slice(0, edges);
    this.reversePrev = this.reversePrev.slice(0, edges);
  }

  /** Sets or clears the caveat of an edge. */
  setCondition(e: number, condition: { name: string; context?: Record<string, unknown> } | undefined): void {
    const current = this.conditions.get(e);
    if (condition === undefined) {
      if (current !== undefined) {
        this.conditions.delete(e);
        this.revision++;
      }
    } else if (current?.name !== condition.name || current.context !== condition.context) {
      this.conditions.set(e, condition);
      this.revision++;
    }
  }

  /** Calls `fn` for every live edge. */
  forEachEdge(fn: (edge: number) => void): void {
    for (let e = 0; e < this.edgeHighWater; e++) {
      if (this.edgeObject[e] !== NONE) fn(e);
    }
  }

  clear(): void {
    // Names and types are kept: compiled schema plans refer to their ids
    this.entities = new SymbolTable();
    this.entityType = new Uint16Array(0);
    this.kind = new Uint8Array(0);
    this.forwardHead = new Int32Array(0);
    this.reverseHead = new Int32Array(0);
    this.forwardCount = new Uint8Array(0);
    this.usersetObjects.clear();
    this.usersetNames.clear();
    this.edgeObject = new Int32Array(0);
    this.edgeRelation = new Uint16Array(0);
    this.edgeSubject = new Int32Array(0);
    this.forwardNext = new Int32Array(0);
    this.forwardPrev = new Int32Array(0);
    this.reverseNext = new Int32Array(0);
    this.reversePrev = new Int32Array(0);
    this.edgeHighWater = 0;
    this.freeEdge = NONE;
    this.liveEdges = 0;
    this.expiry.clear();
    this.conditions.clear();
    this.large.clear();
    this.revision++;
  }

  private buildLarge(object: number): void {
    const large = new Map<number, LargeRelation>();
    for (let e = this.forwardHead[object]!; e !== NONE; e = this.forwardNext[e]!) this.indexLarge(large, e);
    this.large.set(object, large);
  }

  private indexLarge(large: Map<number, LargeRelation>, e: number): void {
    const relationId = this.edgeRelation[e]!;
    let relation = large.get(relationId);
    if (!relation) {
      relation = { subjects: new Map(), indirect: new Set() };
      large.set(relationId, relation);
    }
    const subject = this.edgeSubject[e]!;
    relation.subjects.set(subject, e);
    if (this.kind[subject] !== KIND_OBJECT) relation.indirect.add(e);
  }
}

const EMPTY: Set<number> = new Set();

function symbol(table: SymbolTable, value: string): number {
  const id = table.intern(value);
  if (id > MAX_SYMBOLS) throw new RangeError(`[Zanzo] Too many distinct entity types or relation names (limit ${MAX_SYMBOLS}).`);
  return id;
}
