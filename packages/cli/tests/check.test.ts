import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkCommand } from '../src/commands/check';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Zanzo CLI check command — Soft warnings', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      if (code !== 0) throw new Error(`process.exit(${code})`);
      return undefined as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generates soft warnings for unused actions, relations, and unreferenced entities', async () => {
    const fixturePath = join(__dirname, 'fixtures/dead-schema.ts');

    await checkCommand(fixturePath);

    expect(processExitSpy).toHaveBeenCalledWith(0);

    const warnings = consoleWarnSpy.mock.calls.map(c => c[0] || c[1] || '').join('\n');

    // 1. Unused action
    expect(warnings).toContain('Unused Action "edit"');
    
    // 2. Unused relation
    expect(warnings).toContain('Unused Relation "reviewer"');
    
    // 3. Unreferenced entity
    expect(warnings).toContain('Unreferenced Entity');
    expect(warnings).toContain('[IsolatedDevice]');
    
    // Check final warning count summary
    const logs = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(logs).toContain('Completed with 4 warnings');
  });
});
