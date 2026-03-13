/**
 * Represents a single step in the permission check trace.
 * Each step shows what the engine evaluated: which relation path was tried,
 * on which target, whether a match was found, and which subjects were present.
 */
export interface TraceStep {
  /** The full relation path being evaluated (e.g. 'owner', 'team.member') */
  path: string;
  /** The current target being checked (e.g. 'Document:doc1', 'Team:Devs') */
  target: string;
  /** Whether a matching subject was found at this step */
  found: boolean;
  /** Subjects that hold this relation on the target (for debugging) */
  subjects: string[];
}

/**
 * Result of a traced permission check via `engine.for(actor).check(action).on(resource)`.
 * Provides both the boolean result and a detailed trace of the evaluation path.
 */
export interface CheckResult {
  /** Whether the actor is authorized to perform the action on the resource */
  allowed: boolean;
  /** Step-by-step trace of the permission evaluation */
  trace: TraceStep[];
}
