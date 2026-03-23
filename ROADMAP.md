# Roadmap - Zanzo

A continuación se detalla el plan de desarrollo para llegar a la versión completa del motor de ReBAC:

- [x] **Fase 1: Tipos estáticos e inferencia**
  Establecer los cimientos del sistema usando el *type system* de TypeScript para inferir y autocompletar políticas.

- [x] **Fase 2: Schema Builder (API fluida)**
  Desarrollo de una API *fluent* para facilitar la construcción declarativa del modelo de negocio, recursos y roles.

- [x] **Fase 3: Motor de evaluación en memoria**
  Motor interno capaz de verificar las políticas sincrónicamente cuando los datos requeridos ya están en el entorno de ejecución.

- [x] **Fase 4: Generación de AST**
  Traducción de las reglas y queries de permisos en un Abstract Syntax Tree (AST) utilizable para *Query Pushdown* en bases de datos.

- [x] **Fase 5: Cliente Frontend y optimización por Bitmask/JSON plano**
  Distribución del SDK ligero para frontend, incorporando estrategias de compresión de roles y permisos (ej. Bitmasks o JSON estructurado).

- [x] **Fase 6: Monorepo Setup (Turborepo & Changesets)**
  Orquestación del código en paquetes satélite `packages/*` utilizando pnpm workspaces y Turborepo para compilación distribuida en paralelo.

- [x] **Fase 7: Prisma Adapter**
  Creación de paquete `@zanzo/prisma` como Proof of Concept para traduccción de AST a sintaxis WhereInput.

- [x] **Fase 8 & 9: Drizzle ORM Zero-Config Universal Adapter**
  Introducción del Zanzibar Pattern real acoplando el AST genérico contra la infraestructura de Sub-Consultas (EXISTS) apuntando a una Tabla Universal de Tuplas (Object-Relation-Subject).
 
- [x] **Fase 10: Ecosistema React (@zanzo/react)**
  Bindings de UI para resolución tipada en cliente en arquitectura O(1) usando Inyección de Dependencia en React Context.

- [x] **Fase 11: Documentación Final**
  Escritura de README general enfocado a Developer Experience y ecosistema B2B SaaS.

- [x] **Fase 12: EntityRef Refactor (Centralización de Referencias)**
  Centralización del contrato implícito "Type:ID" en un módulo `ref/` con validación estricta (`parseEntityRef`, `serializeEntityRef`, `ref`), constantes canónicas (`ENTITY_REF_SEPARATOR`, `RELATION_PATH_SEPARATOR`), y eliminación de todos los `.split(':')` / `.split('.')` / `.join('.')` dispersos en el codebase.

- [x] **Fase 13: DX Sprint (Developer Experience Pre-Release)**
  README reescrito con flujo end-to-end completo (Step 2.5: expandTuples + Step 3: snapshot → hydration). Smart default en `warnOnNestedConditions` con auto-detección de NODE_ENV. Documentación de arquitectura (`ARCHITECTURE.md`) cubriendo los 4 contratos implícitos del sistema.

- [x] **Fase 14: collapseTuples — Revocación Simétrica**
  Extracción de `_walkExpansionGraph` en `walk.ts` como algoritmo compartido. `collapseTuples` implementado como inverso simétrico verificado de `expandTuples`. Zero duplicación de lógica de traversal. Suite de simetría confirma que ambas funciones producen resultados idénticos.

- [x] **Fase 15: Test App End-to-End (apps/test-app)**
  Aplicación Next.js 14 + SQLite (better-sqlite3) + Drizzle ORM dentro del monorepo. Prueba el flujo completo: schema → expandTuples/collapseTuples → snapshot → ZanzoProvider → useZanzo(). Portal multi-workspace con 3 usuarios (alice/admin, bob/viewer, carol/sin acceso) y 2 workspaces con módulos dinámicos. Verificado via browser testing.

- [x] **Fase 16: @zanzojs/cli — Interactive Project Scaffolding**
  CLI interactivo para generar boilerplate (schema, migraciones, rutas API y contexto de agentes) en segundos. Soporta Next.js, Express y Hono.

- [x] **Fase 17: v0.3.0 — Improvement & Polish Sprint (Bugs, Performance, CLI)**
  Corrección de bugs críticos (cache partitioning, diamond graphs, race conditions en until). TypeScript estricto. Cache con TTL e invalidación selectiva, `canBatch()`, y filtros de snapshots. Soporte para carga automática de schema.
  - Determinismo temporal (`Date.now()` capturado una vez).
  - Integración de `AbortSignal` en `executePending()`.
  - CLI `zanzo check` con linter de "dead code" (warnings).
  - Versión final lista para despliegue.

- [x] **Fase 18: Frontend Capabilities (ZanzoExtension)**
  Implementación de `ZanzoExtension` para declarar capabilities estáticas por instancia de entidad en el frontend (ej. `Module:ventas` -> `export_csv`), con validación de tuplas, tipo estricto `ExtractCapabilityActions`, e inyección dinámica al motor en memoria usando `engine.loadExtensions()`. Se agregó también el comando `zanzo sync` a `@zanzojs/cli` para sincronización isomórfica directamente a PostgreSQL en *build time*.

- [x] **Fase 19: Ecosistema Angular (@zanzojs/angular)**
  Primer adapter oficial para Angular 19 basado íntegramente en Signals. Soporte nativo para standalone components, pipes puros, directivas estructurales y guards funcionales con integración para SSR (TransferState) y Apollo GraphQL. Verificado con app E2E y suite de integración.

- [x] **Fase 20: Security Patches & Core Hardening (v0.x.1)**
  Parche de seguridad crítico en `@zanzojs/drizzle` (v0.3.1) eliminando cross-user data leakage en caché de AST. Refactorización de `@zanzojs/angular` (v0.1.1) eliminando el God-mode schema dinámico en favor de `ZanzoClient` determinista.

- [x] **Fase 21: Cloudflare Edge & D1 Support (v0.x.2)**
  Certificación de compatibilidad total con el stack Next.js + Cloudflare Pages + D1. Hardening del adapter Drizzle para el Edge Runtime, eliminación de dependencias de Node.js en el core, y validación de complejidad de AST en el CLI. Ejemplo funcional completo en `examples/nextjs-d1`.

- [x] **Fase 22: CLI Starter Kits & Topology Architecture (v0.x.3)**
  Reescritura interactiva del scaffolding del comando `zanzojs init`. Inclusión de pre-validación de rutas/directorios vacíos y separación de Inyección de Dependencias ReBAC por topologías arquitectónicas estrictas (Frontend-only, Backend-only, Fullstack). Adición de Plantillas Mentales Isomorfas pre-construidas (B2B SaaS Multi-tenant, Social Media y Simple RBAC).
