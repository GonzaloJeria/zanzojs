/**
 * Represents a logical combination of multiple conditions in the AST.
 */
export interface QueryAST {
  operator: 'OR' | 'AND';
  conditions: Condition[];
}

/**
 * A condition evaluating a single relation path towards a generic target subject.
 */
export type Condition = DirectCondition | NestedCondition;

/**
 * Represents a direct, 1-level relation requirement.
 * e.g. "We need to find if this resource has the given `targetSubject` as its `relation`".
 */
export interface DirectCondition {
  type: 'direct';
  relation: string;
  targetSubject: string;
}

/**
 * Represents an inherited relation requirement.
 * e.g. "We need to find an intermediate entity linked via `relation` that can satisfy `nextRelationPath` to reach `targetSubject`".
 */
export interface NestedCondition {
  type: 'nested';
  relation: string;
  nextRelationPath: string[]; // E.g for 'parent.owner.member', nextRelationPath would be ['owner', 'member']
  targetSubject: string;
}
