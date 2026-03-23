/**
 * Command: zanzojs init
 * Interactive scaffolding flow using @clack/prompts.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { generateSchema } from '../generators/schema';
import { generateMigration } from '../generators/migration';
import { generateRoutes } from '../generators/routes';
import { generateAgentContext } from '../generators/agent-context';
import type { FrameworkType } from '../templates/routes/permissions';
import type { DatabaseType } from '../templates/migration';
import type { AgentType } from '../generators/agent-context';

export async function initCommand(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(' 🌌 Welcome to ZanzoJS ')));

  const projectNameInput = await p.text({
    message: 'What is your project named? (Leave blank to use current directory)',
    placeholder: 'my-zanzo-app',
  });

  if (p.isCancel(projectNameInput)) { p.cancel('Setup cancelled.'); process.exit(0); }

  const projectName = (projectNameInput as string).trim();
  if (projectName !== '') {
    const projectPath = path.resolve(projectName);
    if (!fs.existsSync(projectPath)) {
      fs.mkdirSync(projectPath, { recursive: true });
    }
    process.chdir(projectPath);
  }

  const topology = await p.select({
    message: 'What type of application are you building?',
    options: [
      { value: 'fullstack', label: 'Fullstack (Next.js, SSR, Remix)' },
      { value: 'backend', label: 'Backend / API Only (Express, Hono, NestJS)' },
      { value: 'frontend', label: 'Frontend Only (React SPA, Angular SPA)' },
    ],
  });

  if (p.isCancel(topology)) { p.cancel('Setup cancelled.'); process.exit(0); }

  const framework = await p.select<{ value: FrameworkType; label: string }[], FrameworkType>({
    message: 'Which framework are you using?',
    options: [
      { value: 'nextjs-app', label: 'Next.js (App Router)' },
      { value: 'nextjs-pages', label: 'Next.js (Pages Router)' },
      { value: 'express', label: 'Express' },
      { value: 'hono', label: 'Hono' },
      { value: 'other', label: 'Other' },
    ],
  });

  if (p.isCancel(framework)) { p.cancel('Setup cancelled.'); process.exit(0); }

  if (!fs.existsSync(path.resolve('package.json'))) {
    const initProject = await p.confirm({
      message: `No package.json found. Initialize a new ${framework} project here?`,
      initialValue: true,
    });
    if (p.isCancel(initProject)) { p.cancel('Setup cancelled.'); process.exit(0); }

    if (initProject) {
      const s = p.spinner();
      const files = fs.readdirSync('.');
      if (files.length > 0) {
        const proceed = await p.confirm({
          message: pc.yellow(`Directory is not empty (${files.length} items found). Proceed anyway? (Likely to fail if using Next.js)`),
          initialValue: false,
        });
        if (!proceed) { p.cancel('Setup cancelled. Please use an empty directory.'); process.exit(0); }
      }

      s.start(`Initializing ${framework} project...`);
      try {
        switch (framework) {
          case 'nextjs-app':
            execSync('npx -y create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-pnpm --yes', { stdio: 'pipe' });
            break;
          case 'nextjs-pages':
            execSync('npx -y create-next-app@latest . --typescript --tailwind --eslint --no-app --src-dir --import-alias "@/*" --use-pnpm --yes', { stdio: 'pipe' });
            break;
          case 'hono':
            execSync('npm init -y && pnpm add hono', { stdio: 'pipe' });
            break;
          case 'express':
            execSync('npm init -y && pnpm add express', { stdio: 'pipe' });
            break;
          default:
            execSync('npm init -y', { stdio: 'pipe' });
        }
        s.stop(`${framework} project initialized!`);
      } catch (err) {
        s.stop('Manual initialization might be required.');
        const message = err instanceof Error ? (err as any).stderr?.toString() || err.message : String(err);
        p.log.error(`Failed to initialize project: ${message}`);
      }
    }
  }

  let _orm = 'none';
  let database = 'sqlite';

  if (topology !== 'frontend') {
    _orm = await p.select({
      message: 'Which ORM are you using?',
      options: [
        { value: 'drizzle', label: 'Drizzle' },
        { value: 'none', label: 'None' },
      ],
    }) as string;
    if (p.isCancel(_orm)) { p.cancel('Setup cancelled.'); process.exit(0); }

    database = await p.select<{ value: DatabaseType; label: string }[], DatabaseType>({
      message: 'Which database are you using?',
      options: [
        { value: 'postgresql', label: 'PostgreSQL' },
        { value: 'sqlite', label: 'SQLite / Cloudflare D1' },
        { value: 'mysql', label: 'MySQL' },
      ],
    }) as string;
    if (p.isCancel(database)) { p.cancel('Setup cancelled.'); process.exit(0); }
  }

  const agent = await p.select<{ value: AgentType; label: string }[], AgentType>({
    message: 'Which AI agent or IDE are you using?',
    options: [
      { value: 'cursor', label: 'Cursor' },
      { value: 'windsurf', label: 'Windsurf' },
      { value: 'claude', label: 'Claude (Anthropic / claude.ai)' },
      { value: 'copilot', label: 'GitHub Copilot' },
      { value: 'antigravity', label: 'Antigravity (Google DeepMind)' },
      { value: 'none', label: 'None' },
    ],
  });
  if (p.isCancel(agent)) { p.cancel('Setup cancelled.'); process.exit(0); }

  let selectedTemplate: string | string[] = 'b2b';

  if (topology !== 'frontend') {
    const templateChoice = await p.select({
      message: 'Which permission model describes your application best?',
      options: [
        { value: 'b2b', label: 'B2B SaaS (Workspace, Document, User)' },
        { value: 'social', label: 'Social Media (Group, Post, User)' },
        { value: 'rbac', label: 'Simple RBAC (Feature, SystemRole, User)' },
        { value: 'custom', label: 'Custom (Define my own entities)' },
      ],
    });
    if (p.isCancel(templateChoice)) { p.cancel('Setup cancelled.'); process.exit(0); }

    if (templateChoice === 'custom') {
      const entitiesInput = await p.text({
        message: 'What entities do you need? (comma separated, e.g. User,Organization,Project)',
        placeholder: 'User, Organization, Project',
        defaultValue: 'User, Organization, Project',
        validate(value) {
          if (!value.trim()) return 'Please enter at least one entity.';
          return undefined;
        },
      });
      if (p.isCancel(entitiesInput)) { p.cancel('Setup cancelled.'); process.exit(0); }
      selectedTemplate = (entitiesInput as string).split(',').map(e => e.trim()).filter(e => e.length > 0);
    } else {
      selectedTemplate = templateChoice as string;
    }
  } else {
    selectedTemplate = 'b2b';
  }

  const outputDir = await p.text({
    message: 'Where should files be generated?',
    placeholder: 'src/',
    defaultValue: 'src/',
  });
  if (p.isCancel(outputDir)) { p.cancel('Setup cancelled.'); process.exit(0); }

  const s = p.spinner();
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  s.start('Generating ZanzoJS core files...');
  await sleep(600);

  s.message('Building your ReBAC schema...');
  await generateSchema(selectedTemplate, outputDir as string);
  await sleep(400);

  if (topology !== 'frontend') {
    s.message('Creating database migration...');
    await generateMigration(database as DatabaseType);
    await sleep(400);

    s.message(`Generating ${framework} API routes...`);
    await generateRoutes(framework as FrameworkType, outputDir as string);
    await sleep(400);
  }

  s.message('Configuring AI agent context...');
  await generateAgentContext(agent as AgentType);
  await sleep(400);

  s.stop(pc.green('Boilerplate generated successfully!'));

  const migrationCommand = getMigrationCommand(database as DatabaseType);
  const routePaths = getRoutePaths(framework, outputDir as string);

  const steps = [
    `${pc.bold('ZanzoJS is ready. Next steps:')}`,
    ''
  ];
  if (topology !== 'frontend') {
    steps.push(`  1. Run the migration:`);
    steps.push(`     ${pc.cyan(migrationCommand)}`);
    steps.push('');
  }
  steps.push(`  ${topology !== 'frontend' ? '2' : '1'}. Customize your schema:`);
  steps.push(`     ${pc.cyan('zanzo.config.ts')}`);
  steps.push('');
  
  if (topology !== 'frontend') {
    steps.push(`  3. Connect your DB in the API routes:`);
    steps.push(...routePaths.map((r) => `     ${pc.cyan(r)}`));
    steps.push('');
    steps.push(`  4. Wrap your app with ZanzoProvider:`);
  } else {
    steps.push(`  2. Wrap your app with ZanzoProvider:`);
  }
  
  steps.push(`     Fetch the snapshot server-side and pass it as an object:`);
  steps.push('');
  steps.push(`     ${pc.dim('// 1. Fetch snapshot')}`);
  steps.push(`     const snapshot = await fetch('/api/permissions?userId=...').then(r => r.json());`);
  steps.push('');
  steps.push(`     ${pc.dim('// 2. Pass to provider')}`);
  steps.push(`     <ZanzoProvider snapshot={snapshot}>...<\/ZanzoProvider>`);
  steps.push('');
  steps.push(`  Docs: ${pc.underline('https://github.com/GonzaloJeria/zanzo')}`);

  p.note(steps.join('\n'), 'Next Steps');
  p.outro(pc.green('Done! Happy building 🚀'));
}

function getMigrationCommand(database: DatabaseType): string {
  switch (database) {
    case 'postgresql': return 'psql -d your_database -f zanzo-migration.sql';
    case 'sqlite': return 'sqlite3 your.db < zanzo-migration.sql';
    case 'mysql': return 'mysql -u root -p your_database < zanzo-migration.sql';
  }
}

function getRoutePaths(framework: FrameworkType, outputDir: string): string[] {
  switch (framework) {
    case 'nextjs-app':
      return [
        `${outputDir}app/api/permissions/route.ts`,
        `${outputDir}app/api/grant/route.ts`,
        `${outputDir}app/api/revoke/route.ts`,
      ];
    case 'nextjs-pages':
      return [
        `${outputDir}pages/api/permissions.ts`,
        `${outputDir}pages/api/grant.ts`,
        `${outputDir}pages/api/revoke.ts`,
      ];
    default:
      return [
        `${outputDir}routes/permissions.ts`,
        `${outputDir}routes/grant.ts`,
        `${outputDir}routes/revoke.ts`,
      ];
  }
}
