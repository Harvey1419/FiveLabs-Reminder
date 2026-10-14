import {
  createTasksBatch,
  findOrCreateEntityFuzzy,
  findOrCreateProjectFuzzy,
  inspectOwnedEntityReferences,
  saveReminder,
} from '../../infrastructure/database/index.js';
import { getReminderConfirmationPreference } from '../../infrastructure/database/memories.js';
import { normalizeTaskPriority } from '../../infrastructure/database/tasks.js';
import { parseTargetTime, DEFAULT_TIMEZONE } from '../../shared/time.js';
import { formatErrorCard } from './formatters.js';
import { createTaskCreateTool } from './task-create-tool.js';
const tool = createTaskCreateTool({
  createTasksBatch: ((...args: Parameters<typeof createTasksBatch>) => createTasksBatch(...args)) as unknown as Parameters<typeof createTaskCreateTool>[0]['createTasksBatch'],
  findOrCreateEntityFuzzy: ((...args: Parameters<typeof findOrCreateEntityFuzzy>) => findOrCreateEntityFuzzy(...args)) as unknown as Parameters<typeof createTaskCreateTool>[0]['findOrCreateEntityFuzzy'],
  findOrCreateProjectFuzzy: ((...args: Parameters<typeof findOrCreateProjectFuzzy>) => findOrCreateProjectFuzzy(...args)) as unknown as Parameters<typeof createTaskCreateTool>[0]['findOrCreateProjectFuzzy'],
  inspectOwnedEntityReferences: ((...args: Parameters<typeof inspectOwnedEntityReferences>) => inspectOwnedEntityReferences(...args)) as unknown as Parameters<typeof createTaskCreateTool>[0]['inspectOwnedEntityReferences'],
  saveReminder: ((...args: Parameters<typeof saveReminder>) => saveReminder(...args)) as unknown as Parameters<typeof createTaskCreateTool>[0]['saveReminder'],
  getReminderConfirmationPreference: ((...args: Parameters<typeof getReminderConfirmationPreference>) => getReminderConfirmationPreference(...args)) as unknown as Parameters<typeof createTaskCreateTool>[0]['getReminderConfirmationPreference'],
  normalizeTaskPriority: ((...args: Parameters<typeof normalizeTaskPriority>) => normalizeTaskPriority(...args)) as unknown as Parameters<typeof createTaskCreateTool>[0]['normalizeTaskPriority'],
  parseTargetTime: ((...args: Parameters<typeof parseTargetTime>) => parseTargetTime(...args)) as unknown as Parameters<typeof createTaskCreateTool>[0]['parseTargetTime'],
  DEFAULT_TIMEZONE: DEFAULT_TIMEZONE as unknown as Parameters<typeof createTaskCreateTool>[0]['DEFAULT_TIMEZONE'],
  formatErrorCard: ((...args: Parameters<typeof formatErrorCard>) => formatErrorCard(...args)) as unknown as Parameters<typeof createTaskCreateTool>[0]['formatErrorCard'],
  logger: console, getNowMs: () => Date.now(),
});
export function executeTaskCreate(...args: Parameters<typeof tool.executeTaskCreate>) { return tool.executeTaskCreate(...args); }


