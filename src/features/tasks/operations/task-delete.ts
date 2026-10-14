import {
  deleteTask,
  cancelRemindersByTaskId,
} from '../../../infrastructure/database/index.js';
import { resolveTaskTarget } from '../../../agent/tools/task-reference.js';
import { createTaskDeleteTool } from './task-delete-tool.js';
const tool = createTaskDeleteTool({
  deleteTask: ((...args: Parameters<typeof deleteTask>) => deleteTask(...args)) as unknown as Parameters<typeof createTaskDeleteTool>[0]['deleteTask'],
  cancelRemindersByTaskId: ((...args: Parameters<typeof cancelRemindersByTaskId>) => cancelRemindersByTaskId(...args)) as unknown as Parameters<typeof createTaskDeleteTool>[0]['cancelRemindersByTaskId'],
  resolveTaskTarget: ((...args: Parameters<typeof resolveTaskTarget>) => resolveTaskTarget(...args)) as unknown as Parameters<typeof createTaskDeleteTool>[0]['resolveTaskTarget'],
  logger: console, getNowMs: () => Date.now(),
});
export function executeTaskDelete(...args: Parameters<typeof tool.executeTaskDelete>) { return tool.executeTaskDelete(...args); }
