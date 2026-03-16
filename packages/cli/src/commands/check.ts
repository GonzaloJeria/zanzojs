import { createJiti } from 'jiti';
import { resolve } from 'path';
import picocolors from 'picocolors';
import { fileURLToPath } from 'url';

export async function checkCommand(configPath: string) {
  console.log(picocolors.blue(`[Zanzo] Validating schema at: ${configPath}\n`));

  try {
    const jiti = createJiti(fileURLToPath(import.meta.url));
    const resolvedPath = resolve(process.cwd(), configPath);
    
    // Load config statically without transpilation step
    const mod = await jiti.import(resolvedPath) as any;
    
    const rawSchema = mod.schema || (mod.default && mod.default.schema) || mod.default;

    if (!rawSchema || typeof rawSchema !== 'object') {
      console.error(picocolors.red('✖ Error: Could not export a valid Zanzo schema from the provided config.'));
      console.error(picocolors.dim('Make sure your config file exports a `schema` object.'));
      process.exit(1);
    }

    let hasErrors = false;
    let warnings = 0;

    const printError = (entity: string, context: string, msg: string, fix?: string) => {
      hasErrors = true;
      console.error(picocolors.red(`✖ [${entity}] ${context}`));
      console.error(`  ${msg}`);
      if (fix) console.error(picocolors.dim(`  Fix: ${fix}\n`));
      else console.error();
    };

    const printWarning = (entity: string, context: string, msg: string) => {
      warnings++;
      console.warn(picocolors.yellow(`⚠ [${entity}] ${context}`));
      console.warn(`  ${msg}\n`);
    };

    // Pre-compute all relations targets across the entire schema to find unreferenced entities
    const allReferencedTargets = new Set<string>();
    for (const definition of Object.values(rawSchema) as any[]) {
      if (definition.relations) {
        for (const target of Object.values(definition.relations)) {
          allReferencedTargets.add(target as string);
        }
      }
    }

    // 1. Check duplicate actions & roles
    for (const [entityName, definition] of Object.entries(rawSchema) as [string, any][]) {
      const actions = definition.actions || [];
      const relations = definition.relations || {};
      const permissions = definition.permissions || {};

      // Duplicated actions
      const actionSet = new Set<string>();
      for (const action of actions) {
        if (actionSet.has(action)) {
          printError(entityName, `Duplicate Action "${action}"`, 
            'The actions array contains a duplicated entry.', 
            'Remove the duplicate from the array.');
        }
        actionSet.add(action);
      }

      // Warning 1: Unused Actions
      const actionsWithPermissions = new Set(Object.keys(permissions));
      const actionsReferencedInPaths = new Set<string>();
      
      for (const paths of Object.values(permissions) as string[][]) {
        for (const path of paths) {
          const firstSegment = path.split('.')[0]!;
          if (actionSet.has(firstSegment)) {
            actionsReferencedInPaths.add(firstSegment);
          }
        }
      }

      for (const action of actions) {
        if (!actionsWithPermissions.has(action) && !actionsReferencedInPaths.has(action)) {
          printWarning(entityName, `Unused Action "${action}"`,
            `The action "${action}" is declared but has no permissions mapping and is never referenced by another action.`);
        }
      }

      // 2. Missing Relations from Permissions & Warning 2 (Unused Relations)
      const definedRelations = new Set(Object.keys(relations));
      const relationsUsedInPermissions = new Set<string>();
      
      for (const [action, paths] of Object.entries(permissions) as [string, string[]][]) {
        for (const path of paths) {
          const segments = path.split('.');
          const firstSegment = segments[0]!;
          
          for (const segment of segments) {
            relationsUsedInPermissions.add(segment);
          }

          // If the first segment is not a relation, it might be an alias to another action.
          // Zanzo allows action inheritance if the action exists in the entity.
          if (!definedRelations.has(firstSegment) && !actionSet.has(firstSegment)) {
            printError(entityName, `Missing Relation in permission "${action}"`,
              `The path "${path}" references "${firstSegment}", but it is neither a defined relation nor an action in "${entityName}".`,
              `Add "${firstSegment}" to the relations object of "${entityName}".`);
          }
        }
      }

      for (const relation of definedRelations) {
        if (!relationsUsedInPermissions.has(relation)) {
          printWarning(entityName, `Unused Relation "${relation}"`,
            `The relation "${relation}" is declared but is never referenced in any permission path.`);
        }
      }

      // 3. Circular References inside the Entity Permissions
      // Detect if an action dependency (action -> action) forms a cycle.
      const detectCycle = (currentAction: string, visited: Set<string>, stack: Set<string>) => {
        if (stack.has(currentAction)) {
          return true; // Cycle detected
        }
        if (visited.has(currentAction)) return false;

        visited.add(currentAction);
        stack.add(currentAction);

        const paths = permissions[currentAction] || [];
        for (const path of paths) {
          const firstSegment = path.split('.')[0]!;
          // If the segment references another action within the same entity
          if (actionSet.has(firstSegment)) {
            if (detectCycle(firstSegment, visited, stack)) {
              return true;
            }
          }
        }
        stack.delete(currentAction);
        return false;
      };

      const visited = new Set<string>();
      for (const action of actions) {
        if (!visited.has(action)) {
          if (detectCycle(action, visited, new Set())) {
            printError(entityName, `Circular Reference Detected`,
              `The permission dependencies for action "${action}" create an infinite loop.`,
              'Break the cycle by relying on a base relation instead of interdependent actions.');
          }
        }
      }

      // Warning 3: Unreferenced Entities
      // If an entity is never targeted by any other entity's relation and has no relations itself, it's totally isolated.
      // If it has relations but is just never targeted, it might be a top-level leaf (like Document), but the check warns anyway to encourage pruning dead schemas.
      if (!allReferencedTargets.has(entityName)) {
        printWarning(entityName, `Unreferenced Entity`,
          `This entity is defined in the schema but no other entity references it in its relations.`);
      }
    }

    if (hasErrors) {
      console.error(picocolors.bold(picocolors.red('\n✖ Zanzo schema validation failed.')));
      process.exit(1);
    } else {
      console.log(picocolors.bold(picocolors.green('✔ Zanzo schema is valid!')));
      if (warnings > 0) {
        console.log(picocolors.yellow(`  Completed with ${warnings} warnings.`));
      }
      process.exit(0);
    }
  } catch (error: any) {
    console.error(picocolors.bold(picocolors.red('\n✖ Critical Error during validation execution:')));
    
    // Format JITI or Node module resolution errors nicely
    if (error.code === 'MODULE_NOT_FOUND' || (error.message && error.message.includes('Cannot find module'))) {
      console.error(picocolors.yellow(`  Could not locate or load the configuration file:`));
      console.error(`  ${configPath}`);
      console.error(picocolors.dim(`  Ensure the path is correct and the file exists.`));
    } else if (error.message && error.message.includes('ParseError')) {
      console.error(picocolors.yellow(`  Syntax error inside the configuration file:`));
      // Extract the relevant parse error bit without the internal JITI stack
      const cleanError = error.message.split('\n')[0];
      console.error(`  ${cleanError}`);
      console.error(picocolors.dim(`  Fix the TypeScript/JavaScript syntax to proceed.`));
    } else {
      console.error(picocolors.yellow(`  ${error.message || error}`));
    }
    process.exit(1);
  }
}
