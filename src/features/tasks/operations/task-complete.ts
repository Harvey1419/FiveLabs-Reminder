import {
  completeTasksByQuery,
  updateTask,
  acknowledgeRemindersByTaskId,
} from '../../../infrastructure/database/index.js';
import { resolveTaskTarget } from '../../../agent/tools/task-reference.js';
import { createTaskCompleteTool } from './task-complete-tool.js';
const tool = createTaskCompleteTool({
  completeTasksByQuery: ((...args: Parameters<typeof completeTasksByQuery>) => completeTasksByQuery(...args)) as unknown as Parameters<typeof createTaskCompleteTool>[0]['completeTasksByQuery'],
  updateTask: ((...args: Parameters<typeof updateTask>) => updateTask(...args)) as unknown as Parameters<typeof createTaskCompleteTool>[0]['updateTask'],
  acknowledgeRemindersByTaskId: ((...args: Parameters<typeof acknowledgeRemindersByTaskId>) => acknowledgeRemindersByTaskId(...args)) as unknown as Parameters<typeof createTaskCompleteTool>[0]['acknowledgeRemindersByTaskId'],
  resolveTaskTarget: ((...args: Parameters<typeof resolveTaskTarget>) => resolveTaskTarget(...args)) as unknown as Parameters<typeof createTaskCompleteTool>[0]['resolveTaskTarget'],
  logger: console, getNowMs: () => Date.now(),
});
export function executeTaskComplete(...args: Parameters<typeof tool.executeTaskComplete>) { return tool.executeTaskComplete(...args); }
