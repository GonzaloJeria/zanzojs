# Manual de Uso de ZanzoJS (v0.3.0)

Este es el manual definitivo y exhaustivo del ecosistema ZanzoJS (v0.3.0), una librería isomórfica de **ReBAC** (Relationship-Based Access Control) diseñada para resolver autorización compleja en aplicaciones TypeScript modernas.

---

## Parte 1 — Lo Básico (Producción)

### 1. El Concepto de Tuplas
A diferencia de RBAC tradicional donde la lógica de acceso está repartida en columnas o múltiples tablas, en ZanzoJS **toda tu autorización vive en una sola tabla** como relaciones planas, conocidas como "Tuplas".
Toda tupla sigue estricto orden direccional:

`Subject` ➔ `Relation` ➔ `Object`

- **Subject:** El identificador del actor (`"User:alice"`).
- **Relation:** El tipo de vínculo (`"owner"`, `"viewer"`, `"admin"`).
- **Object:** El identificador del recurso protegido (`"Document:doc1"`).

### 2. Definición del Schema (Single Source of Truth)
El schema de Zanzo dicta cómo estas relaciones heredan y construyen acceso. Se define en `zanzo.config.ts` y se exporta para todo el ecosistema (backend y frontend):

```typescript
import { ZanzoBuilder, ZanzoEngine } from '@zanzojs/core';

export const schema = new ZanzoBuilder()
  .entity('Workspace', {
    actions: ['delete_workspace', 'view_metrics'],
    relations: { owner: 'User', admin: 'User' },
    permissions: { 
      delete_workspace: ['owner'],
      view_metrics: ['owner', 'admin']
    }
  })
  .entity('Document', {
    actions: ['read', 'edit'],
    relations: { viewer: 'User', workspace: 'Workspace' },
    permissions: {
      // Para leer, puedes ser el viewer directo, o heredar del workspace padre
      read: ['viewer', 'workspace.admin', 'workspace.owner'],
      // Solo via el dueño del workspace puede editar
      edit: ['workspace.owner']
    }
  })
  .entity('User', { actions: [], relations: {} })
  .build();

export const engine = new ZanzoEngine(schema);
```

### 3. La Tabla Universal y Base de Datos (Drizzle ORM)
En tu base de datos (SQLite, PostgreSQL, MySQL), creas **UNA sola tabla** de tuplas. Zanzo es "zero-config", por lo que esta tabla no necesita Foreign Keys, pero **sí necesita** tres índices específicos para que los subqueries (AST) vuelen.

```typescript
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const zanzoTuples = sqliteTable('zanzo_tuples', {
  object: text('object').notNull(),
  relation: text('relation').notNull(),
  subject: text('subject').notNull(),
});
```

> [!IMPORTANT]
> **Índices recomendados:**
> 1. `CREATE UNIQUE INDEX idx_zanzo_unique ON zanzo_tuples (subject, relation, object);`
> 2. `CREATE INDEX idx_zanzo_sub_rel ON zanzo_tuples (subject, relation);`
> 3. `CREATE INDEX idx_zanzo_obj_rel ON zanzo_tuples (object, relation);`

### 4. Escribir y Revocar Permisos (Patrón Transaccional)
Como Zanzo empuja la evaluación a la base de datos (Query Pushdown), el anidamiento (`workspace.owner` -> `Document.edit`) se debe pre-calcular en tiempo de escritura.

#### Otorgar (Creación de relación)
Usas `materializeDerivedTuples`. 
⚠️ **Regla de oro:** El callback `fetchChildren` debe recibir la variable de la transacción `tx` y ejecutar sus queries dentro de ella para evitar *race conditions*.

```typescript
import { materializeDerivedTuples, deduplicateTuples } from '@zanzojs/core';

async function assignWorkspaceAdmin(workspaceId: string, userId: string) {
  const baseTuple = { subject: `User:${userId}`, relation: 'admin', object: `Workspace:${workspaceId}` };

  await db.transaction(async (tx) => {
    const derived = await materializeDerivedTuples({
      schema: engine.getSchema(),
      newTuple: baseTuple,
      fetchChildren: async (parentObj, relation) => {
        // ✅ CORRECTO: Usar `tx`
        const docs = await tx.select().from(documents)
          .where(eq(documents.workspaceId, parentObj.split(':')[1]));
        return docs.map(d => `Document:${d.id}`);
      }
    });

    const unique = deduplicateTuples([baseTuple, ...derived]);
    await tx.insert(zanzoTuples).values(unique).onConflictDoNothing();
  });
}
```

#### Revocar (Eliminación de relación)
Usas `removeDerivedTuples` y `buildBulkDeleteCondition`.
⚠️ **Regla de oro:** El borrado de tuplas debe usar las 3 columnas obligatorias (`eq` sobre object, relation y subject) dentro del loop transaccional. **Si filtras solo por `object` borrarás acceso de terceros.**

```typescript
import { removeDerivedTuples, buildBulkDeleteCondition } from '@zanzojs/core';

async function removeWorkspaceAdmin(workspaceId: string, userId: string) {
  const baseTuple = { subject: `User:${userId}`, relation: 'admin', object: `Workspace:${workspaceId}` };

  await db.transaction(async (tx) => {
    const toDelete = await removeDerivedTuples({
      schema: engine.getSchema(),
      revokedTuple: baseTuple,
      fetchChildren: async (parentObj, relation) => {
        const docs = await tx.select().from(documents).where(...);
        return docs.map(d => `Document:${d.id}`);
      }
    });
    
    const conditions = buildBulkDeleteCondition(toDelete);
    
    // ✅ CORRECTO: Borrado explícito de 3 componentes
    for (const [obj, rel, sub] of conditions) {
      await tx.delete(zanzoTuples).where(
        and(
          eq(zanzoTuples.object, obj),
          eq(zanzoTuples.relation, rel),
          eq(zanzoTuples.subject, sub)
        )
      );
    }
    
    // Finalmente, borramos la tupla base
    await tx.delete(zanzoTuples).where(
      and(
        eq(zanzoTuples.object, baseTuple.object),
        eq(zanzoTuples.relation, baseTuple.relation),
        eq(zanzoTuples.subject, baseTuple.subject)
      )
    );
  });
}
```

### 5. Proteger Rutas API (SQL Fast-Path)
Para evaluar acceso sin traer toda tu base de datos a memoria, usas el adaptador SQL. Este convierte el sub-árbol del schema en un `EXISTS` directo a la base de datos.

```typescript
import { createZanzoAdapter } from '@zanzojs/drizzle';

// Inicializar el helper (solo una vez globalmente)
const withPermissions = createZanzoAdapter(engine, zanzoTuples);

export async function getMyDocuments(request: Request) {
  const userId = getSession(request);
  
  // Devuelve el WHERE dinámico
  const filter = withPermissions(`User:${userId}`, 'read', 'Document', documents.id);
  
  const myDocs = await db.select().from(documents).where(filter);
  return Response.json(myDocs);
}
```

### 6. React y el Snapshot del Engine
Para componentes Front-end, serializamos los permisos que el usuario sí tiene y usamos contexto en memoria 0-latencia, bloqueando el render UI no autorizado.

**Servidor (Ej. Next.js Server Component)**:
```typescript
import { createZanzoSnapshot, ZanzoEngine } from '@zanzojs/core';

// 1. Obtener listado de tuplas que le pertenecen a ESTE usuario
const userTuples = await db.select().from(zanzoTuples)
  .where(like(zanzoTuples.subject, `User:${userId}%`));

// 2. Instanciar (aislado a este request de servidor)
const requestEngine = new ZanzoEngine(schema);
requestEngine.load(userTuples); 

// 3. Crear Snapshot puro
const initialSnapshot = createZanzoSnapshot(requestEngine, `User:${userId}`);
// Envía `initialSnapshot` como prop JSON a tu ZanzoProvider cliente
```

**Cliente (React)**:
```tsx
'use client';
import { useZanzo } from '@zanzojs/react';

function EditButton({ docId }) {
  const { can } = useZanzo();

  if (!can('edit', `Document:${docId}`)) {
    return null; 
  }

  return <button>Edit</button>;
}
```

---

## Parte 2 — APIs Avanzadas (v0.3.0+)

### Debug Trace (`check().on()`)
En vez de devolver un silencioso booleano como `can()`, `check()` te retorna la traza paso a paso de exactamente qué verificó y qué falló. Fundamental para inspección de seguridad o soporte técnico.

```typescript
const result = engine.for('User:alice').check('write').on('Document:doc1');

console.log(result.allowed); // false
console.log(result.trace);
// [
//   { path: 'owner', target: 'Document:doc1', found: false, subjects: [] },
//   { path: 'viewer', target: 'Document:doc1', found: false, subjects: ['User:bob'] }
// ]
```

### Batch Processing (`canBatch()`)
Evalúa múltiples acciones contra múltiples recursos compartiendo el mismo grafo de recursos. Convierte lo que sería `O(N)` exploraciones repetitivas en una única pasada combinada de recursos y acciones.

```typescript
const results = engine.for('User:alice').canBatch([
  { action: 'read', resource: 'Document:doc1' },
  { action: 'write', resource: 'Document:doc1' }, // Mismo resource: evaluateAllActions se ejecuta una sola vez
  { action: 'read', resource: 'Document:doc2' },
]);

// Retorna un Map de resultados
results.get('read:Document:doc1');  // true
results.get('write:Document:doc1'); // false
```

### Permission Cache (`enableCache()`)
Habilita la caché interna en memoria por TTL. Útil en workers de larga duración y singletons.
> [!NOTE]
> La caché se invalida **automáticamente** sobre el cache store completo al mutar una tupla programáticamente a través de `engine.addTuple()`, `load()`, `removeTuple()` o `clearTuples()`.

```typescript
engine.enableCache({ ttlMs: 5000 });

engine.for('User:alice').can('read').on('Document:1'); // Cache MISS
engine.for('User:alice').can('read').on('Document:1'); // Cache HIT
engine.grant('owner').to('User:alice').on('Document:1'); // INVALIDA CACHE
engine.disableCache();
```

### Snapshot Filtrado Condicional
Si tienes 50 tipos de entidades en tu SaaS, pero la vista de React del usuario solo cargará "Documentos", no envíes el "Proyecto" o "Organización" en el payload SSR.

```typescript
const snapshot = createZanzoSnapshot(engine, 'User:alice', {
  entityTypes: ['Document', 'Folder'], // Filtras al hidratar
});
```

### Tuple Helpers

> [!NOTE]
> Los alias `expandTuples` y `collapseTuples` siguen exportados y son totalmente funcionales de forma idéntica, pero han sido marcados como `@deprecated`. Serán eliminados en v1.0.0. El path de migración es un simple find-and-replace por `materializeDerivedTuples` y `removeDerivedTuples` respectivamente, ya que sus firmas son idénticas.

- `deduplicateTuples(tuples)`: Retorna el array sin tuplas repetidas evaluadas por la firma base.
- `uniqueTupleKey(tuple)`: Retorna la firma: `"User:1|admin|Org:A"`.
- `buildBulkDeleteCondition(tuples)`: Retorna el array `[object, relation, subject][]` para borrado en masa. **El retorno es en ese orden asimétrico ex profeso por indexación de B-tree.**

### Manejo de Errores Estructurado (`ZanzoError`)
Cualquier falla lanza una clase `ZanzoError`. Puedes atajar esto con códigos tipados para APM.
```typescript
import { ZanzoError, ZanzoErrorCode } from '@zanzojs/core';

try {
  engine.for('bad').can('read').on('Document:1');
} catch (e) {
  if (e instanceof ZanzoError && e.code === ZanzoErrorCode.INVALID_ENTITY_REF) {
    // Sentry / Datadog
  }
}
```

---

## Parte 3 — Testing y Desarrollo Local

ZanzoJS viene con un motor "In-Memory" pensado para escribir tests unitarios de tu negocio súper rápidos sin mockear ORMs.

### API de Engine Local
Puedes construir grafos puramente con Typescript con `.grant()` y `.revoke()` (y estos invalidarán la cache apropiada si corresponde) en memoria:

```typescript
const engine = new ZanzoEngine(schema);

// Escribir Graph en Memoria
engine.grant('owner').to('User:1').on('Workspace:A');
engine.grant('workspace').to('Workspace:A').on('Document:1');

// Testing directo O(1)
expect(engine.for('User:1').can('edit').on('Document:1')).toBe(true);
expect(engine.for('User:invalid').can('read').on('Document:1')).toBe(false);

// Enumerar todo a lo que User:1 tiene acceso (In-Memory solamente)
const accessibleDocs = engine.for('User:1').listAccessible('Document'); 
// [{ object: 'Document:1', actions: ['read', 'edit'] }]

// Cargar data para Testing
engine.load([
  { subject: 'User:2', relation: 'viewer', object: 'Document:2' }
]);
```

### ⚠️ Peligros de Singletons en Desarrollo
> [!WARNING]
> Nunca llames a `engine.load()` acumulativamente ni exportes y ensucies una sola instancia global `export const engine = new ZanzoEngine(...)` dentro del middleware o API handler en tu backend, ya que la concurrencia de Node.js hará que las peticiones goteen datos de usuarios erróneos. Crea una instancia `new ZanzoEngine(schema)` **por cada HTTP request** cuando hidrates perfiles a memoria.

---

## Parte 4 — Referencia Rápida de APIs

| Función | Contexto | Retorno | Concepto |
|---|---|---|---|
| `new ZanzoBuilder()` | Global / Core | `SchemaData` | Modela y tipa tu política global. |
| `new ZanzoEngine(schema)` | Server / Test | `ZanzoEngine` | El motor que orquesta lógica. Una instancia por ciclo de vida. |
| `engine.for(a).can(x).on(r)` | In-Memory / React | `boolean` | Valida permisos en memoria sin delay de red. |
| `engine.for(a).check(x).on(r)` | Debug | `{ allowed, trace }`| Retorna la evaluación auditada paso-a-paso de O(1). |
| `engine.for(a).canBatch(arr)` | In-Memory / Perform. | `Map<string, boolean>` | Procesa peticiones masivas agrupando accesos a grafo. |
| `materializeDerivedTuples` | Backend SQL (Create) | `Promise<RelationTuple[]>` | Computa relaciones jerárquicas transitivas (Padre a Hijo). |
| `removeDerivedTuples` | Backend SQL (Delete) | `Promise<RelationTuple[]>` | Inversa transitiva. |
| `buildBulkDeleteCondition` | Backend SQL (Delete) | `[obj, rel, sub][]` | Convierte tuplas de removal en array transaccional Drizzle. |
| `createZanzoAdapter` | Backend SQL (Read) | `(a, x, r, col) => SQL` | Pushes el AST al DB de la forma más rápida generando subqueries `EXISTS`. |
| `createZanzoSnapshot` | Backend -> SSR -> React| `Record<string, string[]>` | Payload ultra pequeño para pasar a Contextos de Front-End. |
| `engine.grant().to().on()` | Memoria / Testing | `void` | Mutar el store puramente en memoria. |
| `engine.enableCache({ttl})` | Memoria | `void` | Intercepta `can` con un LRU por 3 keys (`actor|action|resource`). |

---

## Parte 5 — Guía de Migración (desde v0.2.x)

ZanzoJS v0.3.0 introduce mejoras estrictas en tipado y manejo de errores. Aquí detallamos los cambios que afectan código existente:

1. **Renombre de Tuple Helpers**
   - *Antes (v0.2.x)*: `expandTuples` y `collapseTuples`.
   - *Ahora (v0.3.0)*: `materializeDerivedTuples` y `removeDerivedTuples`.
   - *Migration Path*: Find-and-replace directo en todo tu proyecto. Las firmas y comportamientos son idénticos. (Las versiones anteriores siguen exportadas pero marcadas como `@deprecated`).

2. **Validación Estricta de Schema (Breaking)**
   - *Antes (v0.2.x)*: Si el schema definía un permiso basado en una relación inexistente (ej. `permissions: { read: ['viewer', 'typo'] }`), pasaba en silencio y fallaba en runtime.
   - *Ahora (v0.3.0)*: `new ZanzoEngine(schema)` aborta la ejecución inmediatamente lanzando el error `ZANZO_MISSING_RELATION`.
   - *Migration Path*: Si al actualizar tu app no arranca, lee el mensaje de error. Te indicará exactamente qué entidad y qué permiso contiene el typo en la relación para que lo arregles en `zanzo.config.ts`.

3. **Formato del Snapshot (Breaking)**
   - *Antes (v0.2.x)*: Usaba un tipo complejo `CompiledPermissions`.
   - *Ahora (v0.3.0)*: Retorna un puro `Record<string, string[]>` altamente serializable.
   - *Migration Path*: Eliminar todas las importaciones e inferencias de `CompiledPermissions` y depender exclusivamente de la inferencia de types de `createZanzoSnapshot`, o usar `Record<string, string[]>`.

---

## Parte 6 — Troubleshooting

### Escenario 1: El Engine crashea en inicialización con `ZANZO_MISSING_RELATION`
- **Causa:** En tu `zanzo.config.ts`, alguna entidad tiene un permiso configurado cuyo path hace referencia a una relación que **no** declaraste en el bloque `relations`.
- **Solución:** ZanzoJS te imprimirá exactamente dónde está el error:
  `[Zanzo] Missing relation: Entity "Document" permission "read" references relation "worspace" (in path "worspace.admin"), but this relation is not defined in the entity's relations map. Defined relations: [viewer, workspace].`
  Corrige el typo (`worspace` -> `workspace`) en tu builder.

### Escenario 2: `can()` devuelve `false` y no sé por qué
- **Causa:** El anidamiento o los paths de la entidad no resuelven para el `actor`.
- **Solución:** Reemplaza tu llamado de `.can()` por el nuevo `.check()`:
  `const res = engine.for('User:1').check('read').on('Document:A'); console.log(res.trace);`
  Lee la traza paso a paso:
  1. Si dice `found: false, subjects: []` en el nivel base de un path delegativo (como `workspace.admin`), significa que a ese Documento nunca se le insertó la tupla de `workspace`. 
  2. Si dice `found: false, subjects: ["User:2"]`, la tupla sí existe pero Alice ("User:1") no está en ella ni hereda el permiso.

### Escenario 3: Leaks de Datos. Usuarios ven permisos de otros usuarios
- **Causa:** Inicializaste `export const engine = new ZanzoEngine(schema)` globalmente en un archivo de tu backend y estás llamando a `engine.load()` acumulando tuplas de múltiples peticiones HTTP concurrentes.
- **Solución:** ZanzoEngine almacena las tuplas en su RAM interna. **Debes instanciarlo por Request**. 
  Elimina el export global. En tu Middleware o Route Handler haz:
  `const requestEngine = new ZanzoEngine(schema); requestEngine.load(tuplesDeEseUsuario);`

---

## Parte 7 — Patrón Multi-Tenant (B2B SaaS)

El modelo más común para B2B interrelaciona jerarquías donde una Cuenta "raíz" da permisos a sus Módulos. 

**Definiendo el modelo en `zanzo.config.ts`**:
```typescript
export const schema = new ZanzoBuilder()
  .entity('Account', {
    actions: [],
    relations: {
      plan_formula: 'Module',
      plan_operacion: 'Module',
      plan_negocio: 'Module'
    },
    permissions: {}
  })
  .entity('Module', {
    actions: ['access'],
    relations: { },
    permissions: {
      // Para acceder al Módulo X, la cuenta debe habértelo asignado vía uno de estos planes
      access: ['Account.plan_formula', 'Account.plan_operacion', 'Account.plan_negocio'] 
    }
  })
  .build();
```

**Activando Planes via Webhook (Stripe)**:
Cuando un usuario termina el checkout de su Plan Operación, insertas las tuplas que unen la Cuenta a los Módulos de ese plan:

```typescript
await db.transaction(async (tx) => {
  // El Plan "Operación" da acceso a 3 módulos base
  const tuples = [
    { subject: 'Account:123', relation: 'plan_operacion', object: 'Module:ventas' },
    { subject: 'Account:123', relation: 'plan_operacion', object: 'Module:stock' },
    { subject: 'Account:123', relation: 'plan_operacion', object: 'Module:reportes' }
  ];
  
  await tx.insert(zanzoTuples).values(tuples).onConflictDoNothing();
});
```

**Upgrade de Plan (Transaccional)**:
Para pasar del Plan Operación al Plan Negocio (que incluye más módulos), eliminas las tuplas viejas y agregas las nuevas atómicamente:

```typescript
await db.transaction(async (tx) => {
  // 1. Borrar acceso al plan anterior (Operación)
  await tx.delete(zanzoTuples).where(
    and(
      eq(zanzoTuples.subject, 'Account:123'),
      eq(zanzoTuples.relation, 'plan_operacion')
    )
  );

  // 2. Dar acceso al nuevo plan (Negocio)
  const newTuples = [
    { subject: 'Account:123', relation: 'plan_negocio', object: 'Module:ventas' },
    { subject: 'Account:123', relation: 'plan_negocio', object: 'Module:stock' },
    { subject: 'Account:123', relation: 'plan_negocio', object: 'Module:reportes' },
    { subject: 'Account:123', relation: 'plan_negocio', object: 'Module:bi_avanzado' } // < Módulo nuevo
  ];
  await tx.insert(zanzoTuples).values(newTuples).onConflictDoNothing();
});
```

**Protegiendo la UI con Drizzle**:
Antes de cargar la vista de "Reportes", verificas si la cuenta del usuario tiene acceso al módulo:

```typescript
// ¿Esta cuenta tiene acceso al módulo de reportes?
const filter = withPermissions('Account:123', 'access', 'Module', modules.id);
const reportes = await db.select().from(modules).where(filter);
```

---

## Parte 8 — Guía de Performance

1. **`can()` vs `canBatch()`**
   - Usa `can()` cuando evalúas un permiso único en un renderizado UI o chequeo simple en memoria.
   - Usa `canBatch()` cuando estés pintando una Data Table de 50 items que requiere saber 3 acciones (read, edit, delete) por item, ya que `canBatch()` resuelve todo en bloque con una sola pasada al AST por row ahorrando múltiples `O(N)` recursivos.

2. **Cuándo usar `enableCache()`**
   - **NO LO USES** en APIs por-request en el backend. Instanciar desde 0 y procesar en RAM vacía toma 0.05ms (irrelevante para cachear).
   - **ÚSALO** en componentes persistentes: Workers, demonios, WebSockets, o en frontends pesados de React Native donde el `engine` queda suspendido globalmente en memoria del equipo local durante horas.

3. **Mitigando costos de `materializeDerivedTuples`**
   - Si asignas a un usuario sobre una cuenta que tiene 100,000 registros, el expansion queue será masivo.
   - **Solución (Sólo Local)**: Limita tu schema. Prefiere herencia a nivel superior (ej. chequear en tiempo de lectura `can('read').on('Workspace:1')`) en lugar de insertar 100,000 tuplas de `can('read').on('Document:X')` transitivamente si no exigen granularidad única.
   - ⚠️ **ADVERTENCIA SQL ADAPTER:** Este patrón de derivación superior **solo** aplica cuando usas el engine en la memoria global (`can()`). Si usas `withPermissions` en tu ORM de backend, ZanzoJS genera queries del tipo `EXISTS` pero **no hace un graph traversal mágico en SQL** por motivos de performance. En ese entorno, los permisos transitivos **deben estar materializados de antemano** en la DB. Por ende, la única solución real a largo plazo para sistemas Enterprise SQL es diseñar tu schema en `zanzo.config.ts` para que dependa de menos niveles de anidamiento innecesarios.

4. **Verificando SQL Indexes**
   - Ante la duda, ponle `EXPLAIN QUERY PLAN` a tu consulta de Drizzle en Dev.
   - Asegúrate de ver `SEARCH TABLE zanzo_tuples USING INDEX idx_zanzo_unique`. Si ves `SCAN TABLE zanzo_tuples`, aplicaste mal tus índices o no creaste el compound index sugerido en `migrations/recommended-indexes.sql`.

---

## Parte 9 — Referencia de Códigos de Error

Lanzados vía la clase `ZanzoError`. El código de error puede validarse mediante `error.code`.

| Código de Error | Descripción | Acción Resolutiva |
|-----------------|------------|-------------------|
| `INVALID_INPUT` | Se proporcionó a la API un string vacío, o >255 chars, o con caracteres invisibles. | Sanitiza tu backend. No aceptes IDs vacíos o corruptos. |
| `INVALID_ENTITY_REF` | Se pasó un resource tipeado incorrectamente, p.e. `"Dcoument"` en vez de `"Document:1"`. | Corrige el typo. Usa siempre el formato `Entity:Id`. |
| `INVALID_FIELD_SEPARATOR` | La ID contiene múltiples separadores `#`. | Limita el uso de `#` a máxima profundidad de un nivel (ej `Doc:1#field`). |
| `MAX_DEPTH_EXCEEDED` | Grafo de relaciones supera profundidad de 50 anidaciones en memoria. | Revisar diseño del schema: probable loop circular inadvertido no estricto. |
| `EXPANSION_LIMIT` | `materializeDerivedTuples` generó más de 500 tuplas y abortó protección anti-DDoS. | Escala el parámetro `maxExpansionSize: 5000` si es un lote legítimo. |
| `AST_OVERFLOW` | La generación SQL generó subqueries anidados muy complejos. | Simplifica tus rutas de `permissions` en tu Schema. |
| `SCHEMA_COLLISION` | Entidad o Action repetida en el Builder. | Remueve el duplicado en el builder. |
| `MISSING_PROVIDER` | Hook `useZanzo` llamado fuera del `ZanzoProvider`. | Envuelve la app de React en el Provider. |
| `MISSING_RELATION` | **(Crashea en Boot)** `permissions` contiene paths hacia `relations` no definidas. | Revisa y corrige el typo en las keys del schema `zanzo.config.ts`. |
| `CYCLE_DETECTED` | Inferencia circular detectada al expandir tuplas en la base de datos (Ej: A→B→A). | Evita relaciones circulares en el fetching y aplica la limpieza en base de datos. |
