import type { SchemaData } from '../builder/index';
import type { RelationTuple } from '../engine/index';
import { _walkExpansionGraph } from './walk';

/**
 * Callback que el usuario debe implementar para proveer los objetos hijos
 * de un objeto padre dado una relación específica.
 * 
 * Ejemplo: para el tuple `User:1 → admin → Org:A`, el engine necesita saber
 * qué Projects pertenecen a `Org:A` via la relación `org` para poder derivar
 * `User:1 → org.admin → Project:X`.
 * 
 * @param parentObject El objeto padre (e.g. "Org:A")
 * @param relationToChildren El nombre de la relación inversa (e.g. "org")
 * @returns Array de identificadores de objetos hijos (e.g. ["Project:1", "Project:2"])
 */
export type FetchChildrenCallback = (
  parentObject: string,
  relationToChildren: string
) => Promise<string[]> | string[];

export interface ExpansionContext {
  schema: Readonly<SchemaData>;
  newTuple: RelationTuple;
  fetchChildren: FetchChildrenCallback;
  /**
   * Maximum number of derived tuples allowed before aborting expansion.
   * Prevents denial-of-service via unbounded queue growth in pathological schemas.
   * @default 500
   */
  maxExpansionSize?: number;
}

/**
 * Dado un nuevo tuple base, calcula todas las tuplas derivadas implícitas
 * que deben ser materializadas en la base de datos para que las nested
 * permission paths funcionen correctamente en el adapter SQL.
 *
 * Esta función es PURA en su lógica: solo lee el schema y delega
 * el acceso a datos al callback provisto. No tiene side effects.
 *
 * @remarks
 * **Resolución Transitiva (Nested de múltiples niveles):** 
 * Para schemas con paths de más de dos niveles (e.g. `parent.org.admin`), los 
 * tuples intermedios también deben ser expandidos. Esta función maneja la 
 * propagación completa automáticamente mediante una cola (queue) interna, 
 * procesando iterativamente cada nuevo tuple derivado hasta agotar las rutas dinámicas.
 * No requiere llamadas manuales recurrentes por parte del desarrollador.
 *
 * @returns Array de RelationTuple derivados que deben ser insertados
 * junto al tuple original. Si no hay derivaciones, retorna [].
 */
export async function expandTuples(ctx: ExpansionContext): Promise<RelationTuple[]> {
  const { schema, newTuple, fetchChildren, maxExpansionSize = 500 } = ctx;

  const walkResults = await _walkExpansionGraph(
    schema,
    newTuple,
    fetchChildren,
    maxExpansionSize,
  );

  return walkResults.map(r => ({
    subject: r.subject,
    relation: r.relation,
    object: r.object,
  }));
}

