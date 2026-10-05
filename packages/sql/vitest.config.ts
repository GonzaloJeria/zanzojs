import { defineConfig } from 'vitest/config';

export default defineConfig({
  // PGlite boots Postgres in WebAssembly; the first test of a file pays for it
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});
