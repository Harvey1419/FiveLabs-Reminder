import { executeReminderCreate } from './reminder-create.js';
import { executeReminderUpdate } from './reminder-update.js';
import { executeReminderReadTool } from './reminder-read.js';
import { executeSingleReminderCancellation } from './reminder-cancel.js';
import { executeBulkReminderCancellation } from './reminder-bulk-cancel.js';
import { executeReminderAcknowledgement } from './reminder-acknowledge.js';
import { executeTaskCreate } from './task-create.js';
import { executeTaskComplete } from './task-complete.js';
import { executeTaskUpdate } from './task-update.js';
import { executeTaskDelete } from './task-delete.js';
import { executeTaskReadTool } from './task-read.js';
import { executeEntityTool } from './entities.js';
import { executeProjectTool } from './projects.js';
import { executeMemoryTool } from './memory.js';
import { executeSubscriptionTool } from './subscriptions.js';
import { executeCalendarTool } from './calendar.js';
import { executeAdminTool } from './admin.js';
import { executeUnifiedAgendaTool } from './unified-agenda.js';
import { formatErrorCard } from './formatters.js';
import { TOOL_NAMES } from '../contracts/tool-names.js';
import { assertTurnLease } from '../core/turn-lease.js';
import { createToolDispatch } from './tool-dispatch.js';
const service = createToolDispatch({
  executeReminderCreate: ((...args: Parameters<typeof executeReminderCreate>) => executeReminderCreate(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeReminderCreate'],
  executeReminderUpdate: ((...args: Parameters<typeof executeReminderUpdate>) => executeReminderUpdate(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeReminderUpdate'],
  executeReminderReadTool: ((...args: Parameters<typeof executeReminderReadTool>) => executeReminderReadTool(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeReminderReadTool'],
  executeSingleReminderCancellation: ((...args: Parameters<typeof executeSingleReminderCancellation>) => executeSingleReminderCancellation(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeSingleReminderCancellation'],
  executeBulkReminderCancellation: ((...args: Parameters<typeof executeBulkReminderCancellation>) => executeBulkReminderCancellation(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeBulkReminderCancellation'],
  executeReminderAcknowledgement: ((...args: Parameters<typeof executeReminderAcknowledgement>) => executeReminderAcknowledgement(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeReminderAcknowledgement'],
  executeTaskCreate: ((...args: Parameters<typeof executeTaskCreate>) => executeTaskCreate(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeTaskCreate'],
  executeTaskComplete: ((...args: Parameters<typeof executeTaskComplete>) => executeTaskComplete(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeTaskComplete'],
  executeTaskUpdate: ((...args: Parameters<typeof executeTaskUpdate>) => executeTaskUpdate(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeTaskUpdate'],
  executeTaskDelete: ((...args: Parameters<typeof executeTaskDelete>) => executeTaskDelete(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeTaskDelete'],
  executeTaskReadTool: ((...args: Parameters<typeof executeTaskReadTool>) => executeTaskReadTool(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeTaskReadTool'],
  executeEntityTool: ((...args: Parameters<typeof executeEntityTool>) => executeEntityTool(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeEntityTool'],
  executeProjectTool: ((...args: Parameters<typeof executeProjectTool>) => executeProjectTool(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeProjectTool'],
  executeMemoryTool: ((...args: Parameters<typeof executeMemoryTool>) => executeMemoryTool(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeMemoryTool'],
  executeSubscriptionTool: ((...args: Parameters<typeof executeSubscriptionTool>) => executeSubscriptionTool(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeSubscriptionTool'],
  executeCalendarTool: ((...args: Parameters<typeof executeCalendarTool>) => executeCalendarTool(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeCalendarTool'],
  executeAdminTool: ((...args: Parameters<typeof executeAdminTool>) => executeAdminTool(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeAdminTool'],
  executeUnifiedAgendaTool: ((...args: Parameters<typeof executeUnifiedAgendaTool>) => executeUnifiedAgendaTool(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['executeUnifiedAgendaTool'],
  formatErrorCard: ((...args: Parameters<typeof formatErrorCard>) => formatErrorCard(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['formatErrorCard'],
  get TOOL_NAMES() { return TOOL_NAMES as unknown as Parameters<typeof createToolDispatch>[0]['TOOL_NAMES']; },
  assertTurnLease: ((...args: Parameters<typeof assertTurnLease>) => assertTurnLease(...args)) as unknown as Parameters<typeof createToolDispatch>[0]['assertTurnLease'],
  logger: console,
});
export { TOOL_NAMES } from '../contracts/tool-names.js';
export function executeTool(...args: Parameters<typeof service.executeTool>) { return service.executeTool(...args); }





export type { LegacyToolUser, LegacyToolRequest } from './remaining-tool-ports.js';
