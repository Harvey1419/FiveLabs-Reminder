import { formatHumanFriendlyDateTime, DEFAULT_TIMEZONE } from '../../shared/time.js';
import { stripReminderPrefix } from '../../shared/reminder-prefix.js';
import { createFormattersTools } from './formatters-tools.js';
const service = createFormattersTools({
  formatHumanFriendlyDateTime: ((...args: Parameters<typeof formatHumanFriendlyDateTime>) => formatHumanFriendlyDateTime(...args)) as unknown as Parameters<typeof createFormattersTools>[0]['formatHumanFriendlyDateTime'],
  get DEFAULT_TIMEZONE(): Parameters<typeof createFormattersTools>[0]['DEFAULT_TIMEZONE'] { return DEFAULT_TIMEZONE as unknown as Parameters<typeof createFormattersTools>[0]['DEFAULT_TIMEZONE']; },
  stripReminderPrefix: ((...args: Parameters<typeof stripReminderPrefix>) => stripReminderPrefix(...args)) as unknown as Parameters<typeof createFormattersTools>[0]['stripReminderPrefix'],
  logger: console,
});
export function formatReminderCreatedCard(...args: Parameters<typeof service.formatReminderCreatedCard>) { return service.formatReminderCreatedCard(...args); }
export function formatReminderCreateOutcomeCard(...args: Parameters<typeof service.formatReminderCreateOutcomeCard>) { return service.formatReminderCreateOutcomeCard(...args); }
export function formatReminderListCard(...args: Parameters<typeof service.formatReminderListCard>) { return service.formatReminderListCard(...args); }
export function formatReminderCreatedTodayCard(...args: Parameters<typeof service.formatReminderCreatedTodayCard>) { return service.formatReminderCreatedTodayCard(...args); }
export function formatReminderCompletedTodayCard(...args: Parameters<typeof service.formatReminderCompletedTodayCard>) { return service.formatReminderCompletedTodayCard(...args); }
export function formatReminderRemainingTodayCard(...args: Parameters<typeof service.formatReminderRemainingTodayCard>) { return service.formatReminderRemainingTodayCard(...args); }
export function formatReminderCancelledCard(...args: Parameters<typeof service.formatReminderCancelledCard>) { return service.formatReminderCancelledCard(...args); }
export function formatReminderUpdatedCard(...args: Parameters<typeof service.formatReminderUpdatedCard>) { return service.formatReminderUpdatedCard(...args); }
export function formatReminderAcknowledgedCard(...args: Parameters<typeof service.formatReminderAcknowledgedCard>) { return service.formatReminderAcknowledgedCard(...args); }
export function formatTaskCreatedCard(...args: Parameters<typeof service.formatTaskCreatedCard>) { return service.formatTaskCreatedCard(...args); }
export function formatTaskListCard(...args: Parameters<typeof service.formatTaskListCard>) { return service.formatTaskListCard(...args); }
export function formatEntityListCard(...args: Parameters<typeof service.formatEntityListCard>) { return service.formatEntityListCard(...args); }
export function formatTaskCompletedCard(...args: Parameters<typeof service.formatTaskCompletedCard>) { return service.formatTaskCompletedCard(...args); }
export function formatEntityDeletedCard(...args: Parameters<typeof service.formatEntityDeletedCard>) { return service.formatEntityDeletedCard(...args); }
export function formatTaskUpdatedCard(...args: Parameters<typeof service.formatTaskUpdatedCard>) { return service.formatTaskUpdatedCard(...args); }
export function formatMemoryListCard(...args: Parameters<typeof service.formatMemoryListCard>) { return service.formatMemoryListCard(...args); }
export function formatErrorCard(...args: Parameters<typeof service.formatErrorCard>) { return service.formatErrorCard(...args); }


