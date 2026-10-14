import { formatHumanFriendlyDateTime } from './time.js';
import { createTaskPresentation } from './task-card-presentation.js';
export const { groupTasksByProject, getTaskTime, countTaskNotes, fullyRenderedTaskFields, formatTaskNotesBadge, formatTaskProjectGroups, formatCanonicalTaskCreate, formatCanonicalTaskComplete, formatCanonicalTaskUpdate, formatCanonicalTaskDelete } = createTaskPresentation({
  formatHumanFriendlyDateTime: (...args) => formatHumanFriendlyDateTime(...args),
});

export type { CanonicalTaskItem, TaskFormatContext } from './task-card-presentation.js';
