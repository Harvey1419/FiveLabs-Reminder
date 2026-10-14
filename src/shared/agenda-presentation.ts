import { formatHumanFriendlyDateTime } from './time.js';
import { formatTaskProjectGroups, getTaskTime, formatTaskNotesBadge, fullyRenderedTaskFields } from './task-presentation.js';
import { isAllPendingScope, normalizeAgendaScope, normalizeTaskScope } from './agenda-scopes.js';

import { createAgendaPresentation } from './agenda-card-presentation.js';
export const { formatCanonicalTaskList, formatCanonicalAgenda } = createAgendaPresentation({
  formatHumanFriendlyDateTime: (...args) => formatHumanFriendlyDateTime(...args),
  formatTaskProjectGroups: (...args) => formatTaskProjectGroups(...args),
  getTaskTime: (...args) => getTaskTime(...args),
  formatTaskNotesBadge: (...args) => formatTaskNotesBadge(...args),
  fullyRenderedTaskFields: (...args) => fullyRenderedTaskFields(...args),
  isAllPendingScope: (...args) => isAllPendingScope(...args),
  normalizeAgendaScope: (...args) => normalizeAgendaScope(...args),
  normalizeTaskScope: (...args) => normalizeTaskScope(...args),
});


