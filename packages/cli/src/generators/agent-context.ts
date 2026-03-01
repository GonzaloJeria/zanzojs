/**
 * Generator: Agent context file
 * Writes IDE-specific agent context rules based on the selected IDE.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as p from '@clack/prompts';
import { agentContextContent } from '../templates/agent-context/claude';

export type AgentType = 'cursor' | 'windsurf' | 'claude' | 'copilot' | 'antigravity' | 'none';

interface AgentFileConfig {
  filename: string;
  displayName: string;
}

function getAgentFileConfig(agent: AgentType): AgentFileConfig | null {
  switch (agent) {
    case 'cursor':
      return { filename: '.cursorrules', displayName: '.cursorrules' };
    case 'windsurf':
      return { filename: '.windsurfrules', displayName: '.windsurfrules' };
    case 'claude':
      return { filename: 'CLAUDE.md', displayName: 'CLAUDE.md' };
    case 'copilot':
      return { filename: '.github/copilot-instructions.md', displayName: '.github/copilot-instructions.md' };
    case 'antigravity':
      return { filename: '.agent/rules.md', displayName: '.agent/rules.md' };
    case 'none':
      return null;
  }
}

export async function generateAgentContext(agent: AgentType): Promise<string | null> {
  const config = getAgentFileConfig(agent);
  if (!config) {
    return null;
  }

  const filePath = path.resolve(config.filename);

  if (fs.existsSync(filePath)) {
    const overwrite = await p.confirm({
      message: `${config.displayName} already exists. Overwrite?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) {
      p.log.warn(`Skipped ${config.displayName}`);
      return filePath;
    }
  }

  const dir = path.dirname(filePath);
  if (dir !== '.') {
    fs.mkdirSync(dir, { recursive: true });
  }

  const content = agentContextContent();
  fs.writeFileSync(filePath, content, 'utf-8');
  p.log.success(`Created ${config.displayName}`);
  return filePath;
}
