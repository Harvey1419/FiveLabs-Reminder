import {
  supabase,
  updateTask,
  rescheduleRemindersByTaskId,
  acknowledgeRemindersByTaskId,
  cancelRemindersByTaskId,
} from '../../../infrastructure/database/index.js';
import { normalizeTaskPriority } from '../../../infrastructure/database/tasks.js';
import { parseTargetTime, DEFAULT_TIMEZONE } from '../../../shared/time.js';
import { resolveTaskTarget } from '../../../agent/tools/task-reference.js';
import { createTaskUpdateTool } from './task-update-tool.js';
const tool = createTaskUpdateTool({
  supabase: { from: ((...args: Parameters<typeof supabase.from>) => supabase.from(...args)) as unknown as Parameters<typeof createTaskUpdateTool>[0]['supabase']['from']},
  updateTask: ((...args: Parameters<typeof updateTask>) => updateTask(...args)) as unknown as Parameters<typeof createTaskUpdateTool>[0]['updateTask'],
  rescheduleRemindersByTaskId: ((...args: Parameters<typeof rescheduleRemindersByTaskId>) => rescheduleRemindersByTaskId(...args)) as unknown as Parameters<typeof createTaskUpdateTool>[0]['rescheduleRemindersByTaskId'],
  acknowledgeRemindersByTaskId: ((...args: Parameters<typeof acknowledgeRemindersByTaskId>) => acknowledgeRemindersByTaskId(...args)) as unknown as Parameters<typeof createTaskUpdateTool>[0]['acknowledgeRemindersByTaskId'],
  cancelRemindersByTaskId: ((...args: Parameters<typeof cancelRemindersByTaskId>) => cancelRemindersByTaskId(...args)) as unknown as Parameters<typeof createTaskUpdateTool>[0]['cancelRemindersByTaskId'],
  normalizeTaskPriority: ((...args: Parameters<typeof normalizeTaskPriority>) => normalizeTaskPriority(...args)) as unknown as Parameters<typeof createTaskUpdateTool>[0]['normalizeTaskPriority'],
  parseTargetTime: ((...args: Parameters<typeof parseTargetTime>) => parseTargetTime(...args)) as unknown as Parameters<typeof createTaskUpdateTool>[0]['parseTargetTime'],
  DEFAULT_TIMEZONE: DEFAULT_TIMEZONE as unknown as Parameters<typeof createTaskUpdateTool>[0]['DEFAULT_TIMEZONE'],
  resolveTaskTarget: ((...args: Parameters<typeof resolveTaskTarget>) => resolveTaskTarget(...args)) as unknown as Parameters<typeof createTaskUpdateTool>[0]['resolveTaskTarget'],
  logger: console, getNowMs: () => Date.now(),
});
export function executeTaskUpdate(...args: Parameters<typeof tool.executeTaskUpdate>) { return tool.executeTaskUpdate(...args); }
