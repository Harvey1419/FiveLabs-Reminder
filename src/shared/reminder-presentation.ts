import { formatHumanFriendlyDateTime } from './time.js';
import { createReminderPresentation } from './reminder-card-presentation.js';
export const { formatRecurrenceLabel, formatCanonicalReminderCreate, formatCanonicalReminderCreateBatch, formatCanonicalReminderCancel, formatCanonicalReminderCancelBatch, formatCanonicalReminderUpdate, formatCanonicalReminderAcknowledge, formatCanonicalReminderList } = createReminderPresentation({
  formatHumanFriendlyDateTime: (...args) => formatHumanFriendlyDateTime(...args),
});

export type { CanonicalReminderItem, ReminderFormatContext } from './reminder-card-presentation.js';
