
import { createReminderAdvanceTools } from './reminder-advance-tools.js';
const service = createReminderAdvanceTools({
  logger: console,
});
export function buildAdvanceNoticeContent(...args: Parameters<typeof service.buildAdvanceNoticeContent>) { return service.buildAdvanceNoticeContent(...args); }
export function parseAdvanceNoticeContent(...args: Parameters<typeof service.parseAdvanceNoticeContent>) { return service.parseAdvanceNoticeContent(...args); }
export function isAdvanceNoticeContent(...args: Parameters<typeof service.isAdvanceNoticeContent>) { return service.isAdvanceNoticeContent(...args); }
export function belongsToMainReminder(...args: Parameters<typeof service.belongsToMainReminder>) { return service.belongsToMainReminder(...args); }
export function getAdvanceNoticeMinutes(...args: Parameters<typeof service.getAdvanceNoticeMinutes>) { return service.getAdvanceNoticeMinutes(...args); }


