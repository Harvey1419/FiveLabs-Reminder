import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

describe('compiled V2 dependency gate', () => {
  it.each(['clean', 'constant SDK', 'indirect dispatch', 'lazy baseline', 'missing module', 'escape', 'unknown import', 'shadowed constant'] as const)('checks %s imports before release', scenario => {
    const root = mkdtempSync(join(tmpdir(), 'v2-boundary-'));
    const write = (file: string, source: string) => { const path = join(root, file); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, source); };
    try {
      write('adapters/agent-core/canary-productivity-router.js', "import '../../features/service.js';");
      write('features/service.js', scenario === 'indirect dispatch' ? "export * from '../agent/tools/index.js';"
        : scenario === 'lazy baseline' ? "await import('../agent/orchestration/router-core.js');"
          : scenario === 'missing module' ? "import './absent.js';"
            : scenario === 'escape' ? "import '../../external.js';"
              : scenario === 'constant SDK' ? "const sdk = 'zod'; await import(sdk);"
                : scenario === 'unknown import' ? 'await import(process.argv[1]);'
                  : scenario === 'shadowed constant' ? "const sdk = 'zod'; function load(sdk) { return import(sdk); }" : 'export const service = true;');
      write('agent/tools/index.js', 'export const executeTool = true;');
      write('agent/orchestration/router-core.js', 'export const baseline = true;');
      const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/checks/v2-domain-boundary.ts'), root], { encoding: 'utf8', timeout: 10000 });
      expect(result.error).toBeUndefined();
      const valid = scenario === 'clean' || scenario === 'constant SDK';
      expect(result.status).toBe(valid ? 0 : 1);
      if (valid) expect(result.stdout).toContain('"forbiddenV1Imports":0');
      else expect(result.stderr).toMatch(/V2 domain depends on V1|Missing V2 domain module|escapes compiled runtime|Unbounded dynamic V2 import/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
