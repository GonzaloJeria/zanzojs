/**
 * Generator: API routes
 * Writes the permissions, grant, and revoke route files
 * based on the selected framework and output directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as p from '@clack/prompts';
import type { FrameworkType } from '../templates/routes/permissions';
import { permissionsRouteTemplate } from '../templates/routes/permissions';
import { grantRouteTemplate } from '../templates/routes/grant';
import { revokeRouteTemplate } from '../templates/routes/revoke';

interface RouteConfig {
  name: string;
  relativePath: string;
  content: string;
}

function getRoutePaths(framework: FrameworkType, outputDir: string): RouteConfig[] {
  const permissions = permissionsRouteTemplate(framework);
  const grant = grantRouteTemplate(framework);
  const revoke = revokeRouteTemplate(framework);

  switch (framework) {
    case 'nextjs-app':
      return [
        { name: 'permissions/route.ts', relativePath: path.join(outputDir, 'app/api/permissions/route.ts'), content: permissions },
        { name: 'grant/route.ts', relativePath: path.join(outputDir, 'app/api/grant/route.ts'), content: grant },
        { name: 'revoke/route.ts', relativePath: path.join(outputDir, 'app/api/revoke/route.ts'), content: revoke },
      ];
    case 'nextjs-pages':
      return [
        { name: 'permissions.ts', relativePath: path.join(outputDir, 'pages/api/permissions.ts'), content: permissions },
        { name: 'grant.ts', relativePath: path.join(outputDir, 'pages/api/grant.ts'), content: grant },
        { name: 'revoke.ts', relativePath: path.join(outputDir, 'pages/api/revoke.ts'), content: revoke },
      ];
    case 'express':
    case 'hono':
    case 'other':
      return [
        { name: 'permissions.ts', relativePath: path.join(outputDir, 'routes/permissions.ts'), content: permissions },
        { name: 'grant.ts', relativePath: path.join(outputDir, 'routes/grant.ts'), content: grant },
        { name: 'revoke.ts', relativePath: path.join(outputDir, 'routes/revoke.ts'), content: revoke },
      ];
  }
}

export async function generateRoutes(framework: FrameworkType, outputDir: string): Promise<string[]> {
  const routes = getRoutePaths(framework, outputDir);
  const created: string[] = [];

  for (const route of routes) {
    const filePath = path.resolve(route.relativePath);

    if (fs.existsSync(filePath)) {
      const overwrite = await p.confirm({
        message: `${route.relativePath} already exists. Overwrite?`,
        initialValue: false,
      });
      if (p.isCancel(overwrite) || !overwrite) {
        p.log.warn(`Skipped ${route.relativePath}`);
        continue;
      }
    }

    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, route.content, 'utf-8');
    p.log.success(`Created ${route.relativePath}`);
    created.push(filePath);
  }

  return created;
}
