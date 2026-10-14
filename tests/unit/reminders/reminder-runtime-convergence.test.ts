import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const toolsDir = path.resolve('src/agent/tools');
const canonicalModules = [
  'reminder-create.ts',
  'reminder-update.ts',
  'reminder-read.ts',
  'reminder-cancel.ts',
  'reminder-bulk-cancel.ts',
  'reminder-acknowledge.ts',
];

describe('reminder runtime convergence', () => {
  it('keeps one canonical module per reminder responsibility', () => {
    for (const file of canonicalModules) {
      expect(fs.existsSync(path.join(toolsDir, file))).toBe(true);
    }
    expect(fs.existsSync(path.join(toolsDir, 'reminders.js'))).toBe(false);
  });

  it('does not reintroduce executeReminderTool', () => {
    const source = fs.readdirSync(toolsDir)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => fs.readFileSync(path.join(toolsDir, file), 'utf8'))
      .join('\n');

    expect(source).not.toContain('executeReminderTool');
  });

  it('does not pass raw user language into reminder create payloads', () => {
    const executorSource = fs.readFileSync(
      path.resolve('src/agent/orchestration/intent-executor.ts'),
      'utf8',
    );

    expect(executorSource).not.toContain('sourceTimeText');
  });
});
