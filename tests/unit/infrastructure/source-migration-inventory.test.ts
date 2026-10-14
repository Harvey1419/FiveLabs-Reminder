import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const loader = createRequire(import.meta.url).resolve('tsx');
const checker = readFileSync(new URL('../../../scripts/checks/source-migration-inventory.ts', import.meta.url), 'utf8');
const directories: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'hermes-inventory-'));
  directories.push(root);
  for (const directory of ['src', 'scripts/checks', 'tests', 'test', 'packages']) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, 'scripts/checks/source-migration-inventory.ts'), checker);
  return root;
}

function inventory(root: string, check = false) {
  return spawnSync(process.execPath, ['--import', loader, 'scripts/checks/source-migration-inventory.ts', ...(check ? ['--check'] : [])], {
    cwd: root,
    env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: '/dev/null' },
    encoding: 'utf8',
    timeout: 10000,
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('full TypeScript completion inventory', () => {
  it('reports maintained JS including root configuration and fails the completion gate', () => {
    const root = fixture();
    writeFileSync(join(root, 'vitest.config.js'), 'export default {};');
    writeFileSync(join(root, 'tests/old.test.mjs'), '');
    writeFileSync(join(root, 'scripts/old.cjs'), '');
    const report = inventory(root);
    expect(report.status, report.stderr).toBe(0);
    expect(JSON.parse(report.stdout).remainingJavaScript).toEqual(['scripts/old.cjs', 'tests/old.test.mjs', 'vitest.config.js']);
    const gate = inventory(root, true);
    expect(gate.status).toBe(1);
    expect(gate.stderr).toContain('3 maintained JavaScript files');
  });

  it('accepts only TypeScript maintained source and excludes generated output and dependencies', () => {
    const root = fixture();
    writeFileSync(join(root, 'vitest.config.ts'), 'export default {};');
    writeFileSync(join(root, 'src/entry.mts'), '');
    writeFileSync(join(root, 'tests/example.cts'), '');
    for (const directory of ['src/dist', 'packages/node_modules', 'test/coverage']) {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, directory, 'generated.js'), '');
    }
    const gate = inventory(root, true);
    expect(gate.status, gate.stderr).toBe(0);
    expect(JSON.parse(gate.stdout)).toMatchObject({ remainingJavaScript: [], counts: { javascript: 0, typescript: 4 } });
  });

  it('fails when a maintained root is missing instead of certifying an incomplete checkout', () => {
    const root = fixture();
    rmSync(join(root, 'src'), { recursive: true });
    const gate = inventory(root, true);
    expect(gate.status).toBe(1);
    expect(gate.stdout).toBe('');
    expect(gate.stderr).toContain('ENOENT');
  });
});
