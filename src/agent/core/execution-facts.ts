import { sanitizeResponseText } from './working-memory-cache.js';
import { formatCanonicalAgenda, formatCanonicalTaskList } from '../../shared/agenda-presentation.js';
import {
  formatCanonicalTaskComplete,
  formatCanonicalTaskCreate,
  formatCanonicalTaskDelete,
  formatCanonicalTaskUpdate,
} from '../../shared/task-presentation.js';
import {
  formatCanonicalEntityCreate,
  formatCanonicalEntityDeduplicate,
  formatCanonicalEntityDelete,
  formatCanonicalEntityList,
  formatCanonicalEntityMerge,
  formatCanonicalEntityRename,
} from '../../shared/entity-presentation.js';
import {
  formatCanonicalReminderAcknowledge,
  formatCanonicalReminderCancel,
  formatCanonicalReminderCreate,
  formatCanonicalReminderList,
  formatCanonicalReminderUpdate,
} from '../../shared/reminder-presentation.js';
import { composeTurnPresentation } from './presentation-policy.js';

import { createExecutionPresentation } from './execution-presentation.js';
export { TASK_CARD_COVERAGE } from './execution-presentation.js';
export const { createExecutionFact, composeExecutionReply } = createExecutionPresentation({
  sanitizeResponseText: (...args) => sanitizeResponseText(...args),
  composeTurnPresentation: (...args) => composeTurnPresentation(...args),
  formatCanonicalAgenda: (data, options) => formatCanonicalAgenda(data, options as Parameters<typeof formatCanonicalAgenda>[1]),
  formatCanonicalTaskList: (data, options) => formatCanonicalTaskList(data, options as Parameters<typeof formatCanonicalTaskList>[1]),
  formatCanonicalTaskComplete: (data, options) => formatCanonicalTaskComplete(data, options as Parameters<typeof formatCanonicalTaskComplete>[1]),
  formatCanonicalTaskCreate: (data, options) => formatCanonicalTaskCreate(data, options as Parameters<typeof formatCanonicalTaskCreate>[1]),
  formatCanonicalTaskDelete: (data, options) => formatCanonicalTaskDelete(data, options as Parameters<typeof formatCanonicalTaskDelete>[1]),
  formatCanonicalTaskUpdate: (data, options) => formatCanonicalTaskUpdate(data, options as Parameters<typeof formatCanonicalTaskUpdate>[1]),
  formatCanonicalEntityCreate: (data, options) => formatCanonicalEntityCreate(data, options as Parameters<typeof formatCanonicalEntityCreate>[1]),
  formatCanonicalEntityDeduplicate: (data, options) => formatCanonicalEntityDeduplicate(data, options as Parameters<typeof formatCanonicalEntityDeduplicate>[1]),
  formatCanonicalEntityDelete: (data, options) => formatCanonicalEntityDelete(data, options as Parameters<typeof formatCanonicalEntityDelete>[1]),
  formatCanonicalEntityList: (data, options) => formatCanonicalEntityList(data, options as Parameters<typeof formatCanonicalEntityList>[1]),
  formatCanonicalEntityMerge: (...args) => formatCanonicalEntityMerge(...args),
  formatCanonicalEntityRename: (...args) => formatCanonicalEntityRename(...args),
  formatCanonicalReminderAcknowledge: (data, options) => formatCanonicalReminderAcknowledge(data, options as Parameters<typeof formatCanonicalReminderAcknowledge>[1]),
  formatCanonicalReminderCancel: (data, options) => formatCanonicalReminderCancel(data, options as Parameters<typeof formatCanonicalReminderCancel>[1]),
  formatCanonicalReminderCreate: (data, options) => formatCanonicalReminderCreate(data, options as Parameters<typeof formatCanonicalReminderCreate>[1]),
  formatCanonicalReminderList: (data, options) => formatCanonicalReminderList(data, options as Parameters<typeof formatCanonicalReminderList>[1]),
  formatCanonicalReminderUpdate: (data, options) => formatCanonicalReminderUpdate(data, options as Parameters<typeof formatCanonicalReminderUpdate>[1]),
});


