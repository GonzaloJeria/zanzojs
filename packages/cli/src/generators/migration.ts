/**
 * Generator: zanzo-migration.sql
 * Writes the Universal Tuple Table migration file to the project root.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as p from '@clack/prompts';
import { migrationTemplate } from '../templates/migration';
import type { DatabaseType } from '../templates/migration';

export async function generateMigration(database: DatabaseType): Promise<string> {
  const filePath = path.resolve('zanzo-migration.sql');

  if (fs.existsSync(filePath)) {
    const overwrite = await p.confirm({
      message: `zanzo-migration.sql already exists. Overwrite?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) {
      p.log.warn('Skipped zanzo-migration.sql');
      return filePath;
    }
  }

  const content = migrationTemplate(database);
  fs.writeFileSync(filePath, content, 'utf-8');
  p.log.success('Created zanzo-migration.sql');
  return filePath;
}
