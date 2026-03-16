/**
 * @zanzojs/cli — Entry Point
 * Registers CLI commands and delegates to the init flow.
 */

import { initCommand } from './commands/init';
import { checkCommand } from './commands/check';

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  if (command === 'init') {
    await initCommand();
  } else if (command === 'check') {
    const configIndex = args.indexOf('--config');
    if (configIndex === -1 || !args[configIndex + 1]) {
      console.error(`  Error: Missing --config <path> flag for check command.\n`);
      process.exit(1);
    }
    await checkCommand(args[configIndex + 1]!);
  } else {
    console.log(`
  @zanzojs/cli — Scaffold your ZanzoJS project

  Usage:
    zanzojs init                   Initialize ZanzoJS in your project
    zanzojs check --config <path>  Validate a zanzo.config.ts schema statically

  Options:
    --help          Show this help message

  Docs: https://github.com/GonzaloJeria/zanzo
`);

    if (command && command !== '--help') {
      console.error(`  Unknown command: ${command}\n`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
