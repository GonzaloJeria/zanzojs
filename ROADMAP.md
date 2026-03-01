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
