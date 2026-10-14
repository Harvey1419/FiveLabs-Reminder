import { sanitizeResponseText } from './working-memory-cache.js';
import { formatCanonicalTaskCreate } from '../../shared/task-presentation.js';
import {
  formatCanonicalReminderCreateBatch,
  formatCanonicalReminderCancelBatch,
} from '../../shared/reminder-presentation.js';
import { formatHumanFriendlyDateTime } from '../../shared/time.js';

import { createTurnPresentation } from './turn-presentation-policy.js';
export { PRESENTATION_KINDS } from './turn-presentation-policy.js';
export const { getFactDomain, classifyTurnPresentation, composeTurnPresentation } = createTurnPresentation({
  sanitizeResponseText: (...args) => sanitizeResponseText(...args),
  formatCanonicalTaskCreate: (...args) => formatCanonicalTaskCreate(...args),
  formatCanonicalReminderCreateBatch: (...args) => formatCanonicalReminderCreateBatch(...args),
  formatCanonicalReminderCancelBatch: (...args) => formatCanonicalReminderCancelBatch(...args),
  formatHumanFriendlyDateTime: (...args) => formatHumanFriendlyDateTime(...args),
});


