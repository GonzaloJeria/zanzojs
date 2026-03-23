# @zanzojs/cli

## 0.3.5

### Patch Changes

- d5a16c6: fix(cli): add verbose error logging to the dependency injection phase to diagnose package.json mutation failures.

## 0.3.4

### Patch Changes

- a3fd7a8: fix(cli): Switch unreliable shell NPM package installations to deterministic package.json AST writes to prevent dependency injection failures in unconfigured environments.

## 0.3.3

### Patch Changes

- 245b6ef: feat(cli): Add functional framework UI generators for B2B/Social templates and auto-inject `@zanzojs` core packages into the target project via standard package-managers.

## 0.3.2

### Patch Changes

- 378f84e: feat(cli): Implement smart directory routing, Framework topologies (Frontend, Backend, Fullstack) and Pre-built Domain Starter Templates (B2B SaaS, Social Media, Simple RBAC).

## 0.3.1

### Patch Changes

- 4a0d5df: Added full compatibility for Cloudflare D1 and Edge Runtime.
  - @zanzojs/drizzle: Refactored NODE_ENV check for Edge compatibility and added D1 documentation.
  - @zanzojs/cli: Added AST complexity validation in `zanzo check` command.
