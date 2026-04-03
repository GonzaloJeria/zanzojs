import * as fs from 'node:fs';
import * as path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { permissionsRouteTemplate } from '../templates/routes/permissions';
import { grantRouteTemplate } from '../templates/routes/grant';
import { revokeRouteTemplate } from '../templates/routes/revoke';
import type { FrameworkType } from '../templates/routes/permissions';

function getBaseRoutesDir(framework: FrameworkType, outputDir: string): string {
  if (framework === 'nextjs-app') return path.join(outputDir, 'app/api');
  if (framework === 'nextjs-pages') return path.join(outputDir, 'pages/api');
  return path.join(outputDir, 'routes');
}

interface RouteConfig {
  name: string;
  relativePath: string;
  content: string;
}

function getRouteContents(framework: FrameworkType, orm: string) {
  if (framework === 'nextjs-app') {
    return {
      permContent: permissionsRouteTemplate(framework, orm),
      grantContent: grantRouteTemplate(framework, orm),
      revokeContent: revokeRouteTemplate(framework, orm),
      ext: 'ts',
    };
  }

  return {
    permContent: permissionsRouteTemplate(framework, orm),
    grantContent: grantRouteTemplate(framework, orm),
    revokeContent: revokeRouteTemplate(framework, orm),
    ext: 'ts',
  };
}

function getRoutePaths(framework: FrameworkType, outputDir: string, orm: string): RouteConfig[] {
  const { permContent, grantContent, revokeContent, ext } = getRouteContents(framework, orm);

  switch (framework) {
    case 'nextjs-app':
      return [
        { name: 'permissions/route.ts', relativePath: path.join(outputDir, 'app/api/permissions/route.ts'), content: permContent },
        { name: 'grant/route.ts', relativePath: path.join(outputDir, 'app/api/grant/route.ts'), content: grantContent },
        { name: 'revoke/route.ts', relativePath: path.join(outputDir, 'app/api/revoke/route.ts'), content: revokeContent },
      ];
    case 'nextjs-pages':
      return [
        { name: 'permissions.ts', relativePath: path.join(outputDir, 'pages/api/permissions.ts'), content: permContent },
        { name: 'grant.ts', relativePath: path.join(outputDir, 'pages/api/grant.ts'), content: grantContent },
        { name: 'revoke.ts', relativePath: path.join(outputDir, 'pages/api/revoke.ts'), content: revokeContent },
      ];
    case 'express':
    case 'hono':
    case 'other':
      return [
        { name: `permissions.${ext}`, relativePath: path.join(outputDir, `routes/permissions.${ext}`), content: permContent },
        { name: `grant.${ext}`, relativePath: path.join(outputDir, `routes/grant.${ext}`), content: grantContent },
        { name: `revoke.${ext}`, relativePath: path.join(outputDir, `routes/revoke.${ext}`), content: revokeContent },
      ];
  }
}

export async function generateRoutes(framework: FrameworkType, orm: string, outputDir: string): Promise<void> {
  const routesDir = getBaseRoutesDir(framework, outputDir);

  if (!fs.existsSync(routesDir)) {
    fs.mkdirSync(routesDir, { recursive: true });
  }

  const routePaths = getRoutePaths(framework, outputDir, orm);
  const created: string[] = [];

  for (const route of routePaths) {
    const filePath = path.resolve(route.relativePath);

    if (fs.existsSync(filePath)) {
      const overwrite = await p.confirm({
        message: pc.yellow(`File ${route.relativePath} already exists. Overwrite?`),
        initialValue: false,
      });
      if (p.isCancel(overwrite) || !overwrite) {
        continue;
      }
    } else {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, route.content, 'utf8');
    created.push(route.name);
  }

  if (created.length > 0) {
    p.log.success(pc.dim(`  Created ${created.length} route files.`));
  } else {
    p.log.step(pc.dim(`  No route files created.`));
  }
}
