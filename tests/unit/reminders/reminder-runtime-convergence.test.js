import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const toolsDir = path.resolve('src/agent/tools');
const canonicalModules = [
  'reminder-create.js',
  'reminder-update.js',
  'reminder-read.js',
  'reminder-cancel.js',
  'reminder-bulk-cancel.js',
  'reminder-acknowledge.js',
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
      .filter((file) => file.endsWith('.js'))
      .map((file) => fs.readFileSync(path.join(toolsDir, file), 'utf8'))
      .join('\n');

    expect(source).not.toContain('executeReminderTool');
  });
});
