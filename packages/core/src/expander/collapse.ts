import type { SchemaData } from '../builder/index';
import type { RelationTuple } from '../engine/index';
import type { FetchChildrenCallback } from './index';
import { _walkExpansionGraph } from './walk';

export interface CollapseContext {
  schema: Readonly<SchemaData>;
  /**
   * El tuple base que se está revocando.
   * Debe ser idéntico al tuple base que se pasó a expandTuples originalmente.
   */
  revokedTuple: RelationTuple;
  fetchChildren: FetchChildrenCallback;
  /**
   * Límite máximo de tuples a procesar en la cola de colapso.
   * Debe ser igual al maxExpansionSize usado al expandir.
   * @default 500
   */
  maxCollapseSize?: number;
}

/**
 * Calcula todos los tuples derivados que deben ser eliminados de la DB
 * cuando se revoca un tuple base previamente expandido con `expandTuples`.
 *
 * Esta función es el inverso simétrico de `expandTuples`. Usa el mismo
 * algoritmo de queue-based traversal y el mismo `fetchChildren` callback
 * para reconstruir qué tuples derivados existen y deben ser borrados.
 *
 * Es PURA: no elimina nada. Retorna los tuples a eliminar para que
 * el caller decida cómo ejecutar el DELETE en su base de datos.
 *
 * @returns Array de RelationTuple que deben ser eliminados,
 * NO incluye el revokedTuple base (el caller lo elimina por separado).
 */
export async function collapseTuples(ctx: CollapseContext): Promise<RelationTuple[]> {
  const { schema, revokedTuple, fetchChildren, maxCollapseSize = 500 } = ctx;

  const walkResults = await _walkExpansionGraph(
    schema,
    revokedTuple,
    fetchChildren,
    maxCollapseSize,
  );

  return walkResults.map(r => ({
    subject: r.subject,
    relation: r.relation,
    object: r.object,
  }));
}
