import jiti from 'jiti';
import postgres from 'postgres';
import path from 'path';
import fs from 'fs';
import * as p from '@clack/prompts';
import pc from 'picocolors';
// Types from core via any so we don't break strict compiler in CLI isolated build
type ExtensionTuple = { subject: string, relation: string, object: string, expiresAt?: Date };
type ZanzoExtension = { toTuples: (relation: string) => ExtensionTuple[], capability: any };

export async function syncCommand(args: string[]): Promise<void> {
  const getFlag = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1] && !args[idx + 1]!.startsWith('--')) {
      return args[idx + 1];
    }
    // Also support --flag=value
    const inlineLog = args.find((a) => a.startsWith(`${flag}=`));
    if (inlineLog) {
      return inlineLog.split('=')[1];
    }
    return undefined;
  };

  const hasFlag = (flag: string): boolean => {
    return args.includes(flag);
  };

  const extensionsPath = getFlag('--extensions');
  const dbUrl = getFlag('--db') || process.env['ZANZO_DB_URL'];
  const relationOpt = getFlag('--relation') || 'module';
  const dryRun = hasFlag('--dry-run');
  const verbose = hasFlag('--verbose');

  if (!extensionsPath) {
    p.log.error(pc.red('Error: Missing --extensions <path> flag required for sync.'));
    process.exit(1);
    return;
  }

  if (!dbUrl) {
    p.log.error(pc.red('Error: Missing DB connection string. Provide via --db flag or ZANZO_DB_URL environment variable.'));
    process.exit(1);
    return;
  }

  const absoluteExtensionsPath = path.resolve(process.cwd(), extensionsPath);
  if (!fs.existsSync(absoluteExtensionsPath)) {
    p.log.error(pc.red(`Error: Extensions file not found at ${absoluteExtensionsPath}`));
    process.exit(1);
    return;
  }

  // Load extensions
  p.log.step(`[Zanzo Sync] Reading extensions from: ${extensionsPath}`);
  
  let extensions: ZanzoExtension;
  try {
    const loader = jiti(process.cwd(), { interopDefault: true });
    const imported = loader(absoluteExtensionsPath);
    
    // Attempt to extract from default export or 'extensions' named export
    extensions = imported.default || imported.extensions || imported;
    
    // Basic duck-typing check to see if it's the expected class shape
    if (!extensions || typeof extensions.toTuples !== 'function') {
      throw new Error(`The exported object does not appear to be a ZanzoExtension instance. Ensure you are exporting an instance of ZanzoExtension.`);
    }
  } catch (err: any) {
    p.log.error(pc.red(`Error loading extensions file: ${err.message}`));
    process.exit(1);
    return;
  }

  const newTuples = extensions!.toTuples(relationOpt) as ExtensionTuple[];

  // Connect to DB
  p.log.step(`[Zanzo Sync] Connecting to database...`);
  const sql = postgres(dbUrl, { max: 1, idle_timeout: 10 }); // Single connection for sync 
  
  try {
    // 1. Fetch current capabilities
    const currentRows = await sql`
      SELECT subject, relation, object 
      FROM zanzo_tuples 
      WHERE object LIKE 'Capability:%' AND relation = ${relationOpt}
    `;

    p.log.info(`[Zanzo Sync] Current state: ${currentRows.length} capability tuples in DB (filtered by relation: '${relationOpt}')`);
    p.log.info(`[Zanzo Sync] Desired state: ${newTuples.length} capability tuples in extensions`);

    // Helper unique key
    const tKey = (t: {subject: string, relation: string, object: string}) => `${t.subject}|${t.relation}|${t.object}`;

    const currentMap = new Map<string, any>();
    for (const r of currentRows) {
      currentMap.set(tKey(r as any), r);
    }

    const desiredMap = new Map<string, ExtensionTuple>();
    for (const t of newTuples) {
      desiredMap.set(tKey(t), t);
    }

    // 2. Compute diff
    const toInsert: ExtensionTuple[] = [];
    const toDelete: any[] = [];

    for (const [key, t] of desiredMap.entries()) {
      if (!currentMap.has(key)) {
        toInsert.push(t);
      }
    }

    for (const [key, r] of currentMap.entries()) {
      if (!desiredMap.has(key)) {
        toDelete.push(r);
      }
    }

    const unchanged = currentRows.length - toDelete.length;

    p.log.step(`[Zanzo Sync] Diff: ${pc.green('+' + toInsert.length)} to insert, ${pc.red('-' + toDelete.length)} to delete, ${unchanged} unchanged`);

    if (verbose) {
      if (toInsert.length > 0) p.log.info(pc.green(`Inserts: \n${toInsert.map(t => `  ${t.subject} -> ${t.object}`).join('\n')}`));
      if (toDelete.length > 0) p.log.info(pc.red(`Deletes: \n${toDelete.map(t => `  ${(t as any).subject} -> ${(t as any).object}`).join('\n')}`));
    }

    // 3. Execute diff in transaction
    if (dryRun) {
      p.log.success(pc.yellow(`[Zanzo Sync] Dry-run mode completed. No changes were made.`));
    } else if (toInsert.length > 0 || toDelete.length > 0) {
      await sql.begin(async (tx) => {
        // Delete removals
        if (toDelete.length > 0) {
          for (const chunk of chunkArray(toDelete, 100)) {
            // we delete by exact match pairs to avoid wiping broadly by accident
              for(const del of chunk) {
                 await (tx as any)`
                    DELETE FROM zanzo_tuples 
                    WHERE subject = ${(del as any).subject} 
                      AND relation = ${(del as any).relation} 
                      AND object = ${(del as any).object}
                 `;
              }
            }
          }

          // Insert new
          if (toInsert.length > 0) {
            for (const chunk of chunkArray(toInsert, 100)) {
               const values = chunk.map(c => ({
                  subject: c.subject,
                  relation: c.relation,
                  object: c.object
               }));
               await (tx as any)`
                  INSERT INTO zanzo_tuples ${(sql as any)(values)}
               `;
            }
          }
        });
      p.log.success(pc.green(`[Zanzo Sync] ✔ Sync completed successfully.`));
    } else {
      p.log.success(pc.green(`[Zanzo Sync] ✔ No changes needed.`));
    }

  } catch (err: any) {
    // Sanitize DB URL from error logs
    const safeUrl = dbUrl.replace(/\/\/[^:]+:[^@]+@/, '//***:***@');
    p.log.error(pc.red(`Error connecting to DB or executing sync via (${safeUrl}): ${err.message}`));
    process.exit(1);
    return;
  } finally {
    await sql.end();
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
