/**
 * @zanzojs/cli — Entry Point
 * Registers CLI commands and delegates to the init flow.
 */

import { initCommand } from './commands/init';

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  if (command === 'init') {
    await initCommand();
  } else {
    console.log(`
  @zanzojs/cli — Scaffold your ZanzoJS project

  Usage:
    zanzojs init    Initialize ZanzoJS in your project

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
