# @zanzojs/cli

The official CLI for ZanzoJS. Scaffolds your project with the correct boilerplate in seconds.

## Usage

No installation needed:
```bash
npx @zanzojs/cli@latest init    # Scaffold a new project
npx @zanzojs/cli@latest check   # Lint and validate your schema
```

Or install globally:
```bash
pnpm add -g @zanzojs/cli
zanzojs init
zanzojs check
```

## What it generates

- **`zanzo.config.ts`** — Your ZanzoJS schema with the entities you specified
- **`zanzo-migration.sql`** — The Universal Tuple Table migration for your database
- **`src/app/api/permissions/route.ts`** — Snapshot compilation endpoint
- **`src/app/api/grant/route.ts`** — Permission grant endpoint with expandTuples
- **`src/app/api/revoke/route.ts`** — Permission revoke endpoint with collapseTuples
- **`.cursorrules` / `CLAUDE.md` / `.windsurfrules`** — Agent context rules for your IDE

## Documentation

[ZanzoJS Monorepo](https://github.com/GonzaloJeria/zanzo)
