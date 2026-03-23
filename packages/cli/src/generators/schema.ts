/**
 * Generator: zanzo.config.ts
 * Writes the schema configuration file to the project root.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as p from '@clack/prompts';
import { schemaTemplate } from '../templates/schema';

export async function generateSchema(input: string | string[], _outputDir: string): Promise<string> {
  const filePath = path.resolve('zanzo.config.ts');

  if (fs.existsSync(filePath)) {
    const overwrite = await p.confirm({
      message: `zanzo.config.ts already exists. Overwrite?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) {
      p.log.warn('Skipped zanzo.config.ts');
      return filePath;
    }
  }

  const content = schemaTemplate(input);
  fs.writeFileSync(filePath, content, 'utf-8');
  p.log.success('Created zanzo.config.ts');
  return filePath;
}
