import { getTaskList } from '../../features/tasks/service.js';
import { createTaskReadTool } from './task-read-tool.js';
const service = createTaskReadTool({
  getTaskList: ((...args: Parameters<typeof getTaskList>) => getTaskList(...args)) as unknown as Parameters<typeof createTaskReadTool>[0]['getTaskList'],
  logger: console, getNowMs: () => Date.now(), getEnv: () => process.env});
export function executeTaskReadTool(...args: Parameters<typeof service.executeTaskReadTool>) { return service.executeTaskReadTool(...args); }


