# Changelog

All notable changes to the ZanzoJS ecosystem will be documented in this file.

## [0.3.0] — 2026-03-13

### Silent Bug Fixes

- **fix(core)**: Reemplazo de serialización en expansión (`expandTuples` / `materializeDerivedTuples`).
  - *Cambio*: El JSDoc ahora exige y muestra el uso de un patrón transaccional para `fetchChildren`, requiriendo que se pase la instancia de la transacción (`tx`) para realizar las queries dentro de la misma.
  - *Impacto*: Previene condiciones de carrera silenciosas (race conditions) entre las consultas de lectura y las escrituras en la base de datos de tuplas.
- **fix(core)**: Optimización del flujo de revocación (`collapseTuples` / `removeDerivedTuples`).
  - *Cambio*: Se ha eliminado el loop de `DELETE` individuales. En su lugar, se introduce el helper `buildBulkDeleteCondition()` que permite realizar un único `DELETE WHERE (object, relation, subject) IN (...)`.
  - *Impacto*: Previene que una falla de red en medio de un loop deje tuplas residuales o bloqueos excesivos de base de datos.
- **fix(core)**: Prevención silenciosa de tuplas duplicadas.
  - *API nueva*: `deduplicateTuples(tuples)` y `uniqueTupleKey(tuple)`.
  - *Impacto*: Permite desduplicar tuplas en memoria antes de intentar un bulk `INSERT`, que emparejado con `ON CONFLICT DO NOTHING`, garantiza inserciones masivas seguras.

### Strict TypeScript

- **feat(core)**: Tipado estricto en la API Fluent (`ForBuilder`, `CanBuilder`, etc.).
  - *Cambio*: `engine.for(actor)`, `.can(action)`, y `.on(resource)` han sido fuertemente tipados.
  - *Impacto*: Typos como `engine.for('user').can('adimn')` ahora producen errores de compilación (`Type '"adimn"' is not assignable to type '"admin"'`).
  - *Migration Path*: Ninguno, pero podrían aparecer errores de compilación nuevos en repositorios donde previamente se casteaban o enviaban strings inválidas en tiempo de compilación. Las strings son limitadas a valores combinando identidades unidas con `:` (`SchemaEntityRef<TSchema>`).
- **feat(core)**: Nuevas Type Utilities exportadas.
  - *Nuevas APIs*: `AllSchemaEntities`, `AllSchemaActions`, `AllSchemaRelations`, `SchemaEntityRef`, `EntityActions`.

### DX — Developer Experience

- **feat(core)**: Sistema unificado de manejo de errores estructurado (`ZanzoError`).
  - *API*: Nueva clase `ZanzoError` que extiende `Error`, y el enumerador exportado `ZanzoErrorCode`.
  - *Impacto*: Introduce 10 códigos de error únicos (como `INVALID_INPUT`, `MAX_DEPTH_EXCEEDED`, `SCHEMA_COLLISION`) permitiendo que herramientas de APM (Datadog, Sentry) puedan agrupar y alertar sobre errores correctamente.
- **feat(core)**: Detección temprana de errores de esquema (`ZANZO_MISSING_RELATION`).
  - *Cambio*: El constructor de `ZanzoEngine` ahora valida la integridad de los "paths" ingresados en el campo `permissions` de un entity. Si el path usa relaciones no declaradas, lanza un error de inmediato.
- **feat(core)**: Detección de ciclos infinitos (`ZANZO_CYCLE_DETECTED`).
  - *Cambio*: La función `materializeDerivedTuples` cuenta con la propiedad algorítmica de trackear referencias circulares. Lanza este error y previene colapsar la memoria del servidor si ocurre A → B → A.
- **feat(core)**: API de Trace Debugging (`CheckResult`).
  - *API nueva*: `engine.for(actor).check(action).on(resource)`.
  - *Impacto*: A diferencia de `can()` que retorna un booleano `O(1)`, `check()` compila y retorna un array detallando la evaluación completa (`{ allowed, trace: TraceStep[] }`) incluyendo los caminos evaluados, si los sujetos fueron detectados en esos paths, iteración a iteración.
- **feat(core)**: Renombres para adherirse a convenciones formales:
  - `expandTuples` → `materializeDerivedTuples` (antiguo nombre deprecated).
  - `collapseTuples` → `removeDerivedTuples` (antiguo nombre deprecated).
  - *Migration Path*: Reemplazo de texto directo. El alias anterior se mantendrá de compatibilidad hasta `v1.0.0`.

### Performance

- **feat(core)**: API de permisos por lotes (`canBatch`).
  - *API nueva*: `engine.for(actor).canBatch(checks)`.
  - *Impacto*: Agrupa las validaciones de acceso de forma óptima usando `evaluateAllActions()`. Reduce traversal repetitivo sobre la misma entidad a una única pasada (O(N) llamadas a O(1)).
- **feat(core)**: Caché en Memoria O(1) con TTL (`PermissionCache`).
  - *Apis nuevas*: `engine.enableCache({ ttlMs: ... })`, `engine.disableCache()`.
  - *Impacto*: Todas las respuestas de `engine.can()` son fuertemente cacheadas e instantáneamente respondidas. La caché es automáticamente invalidada sobre mutaciones `addTuple`, `load`, `removeTuple`, o `clearTuples`.
- **feat(core)**: Filtrado Condicional de Snapshot (`createZanzoSnapshot`).
  - *Modificación*: Acepta un tercer parámetro `options?: { entityTypes: string[] }`. Reduce masivamente los megabytes consumidos serializando data en aplicaciones SSR ignorando resources innecesarios como metadatos si solo requerimos "Document".
- **feat(migrations)**: Índices Recomendados.
  - *Cambio*: Se agrega `migrations/recommended-indexes.sql` para guiar a los ingenieros backend sobre qué índices crear en sus adaptadores (SQLite, Postgres) y hacer que `@zanzojs/drizzle` use verdaderos subqueries filtrados limitados por índices multi-componentes compuestos en un `B-Tree`.

### Breaking Changes
- **breaking(core)**: `CompiledPermissions` ha sido descontinuado; el Snapshot es un record puro serializable de tipo `Record<string, string[]>`.
- **breaking(core)**: Si usas `ZanzoEngine` con un esquema que contenga permisos referenciando relaciones inexistentes, la aplicación ahora abortará su arranque devolviendo un error de `ZANZO_MISSING_RELATION`.
