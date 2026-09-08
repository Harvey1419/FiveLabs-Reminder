import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const toolsDir = path.resolve('src/agent/tools');
const canonicalReminderModules = [
  'reminder-create.js',
  'reminder-update.js',
  'reminder-read.js',
  'reminder-cancel.js',
  'reminder-bulk-cancel.js',
  'reminder-acknowledge.js',
];

describe('reminder runtime convergence', () => {
  it('keeps exactly one canonical module per reminder responsibility', () => {
    for (const file of canonicalReminderModules) {
      expect(fs.existsSync(path.join(toolsDir, file))).toBe(true);
    }
    expect(fs.existsSync(path.join(toolsDir, 'reminders.js'))).toBe(false);
  });

  it('does not reintroduce the legacy executeReminderTool runtime', () => {
    const files = fs.readdirSync(toolsDir).filter((file) => file.endsWith('.js'));
    const combined = files
      .map((file) => fs.readFileSync(path.join(toolsDir, file), 'utf8'))
      .join('\n');

    expect(combined).not.toContain('executeReminderTool');
  });
});
