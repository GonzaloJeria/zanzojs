import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    sqlite: 'src/schema/sqlite.ts',
    pg: 'src/schema/pg.ts',
    mysql: 'src/schema/mysql.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
