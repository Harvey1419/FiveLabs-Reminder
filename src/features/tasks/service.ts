import { supabase } from '../../infrastructure/database/index.js';
import { selectEntityCandidate } from '../../infrastructure/database/entities.js';
import { resolveCalendarTemporalScope, formatLocalDateTime } from '../../shared/time.js';
import { parseTaskScope } from '../../shared/agenda-scopes.js';
import { createTaskReadService } from './task-read-service.js';
const service = createTaskReadService({
  supabase: { from: ((...args: Parameters<typeof supabase.from>) => supabase.from(...args)) as unknown as Parameters<typeof createTaskReadService>[0]['supabase']['from']},
  selectEntityCandidate: ((...args: Parameters<typeof selectEntityCandidate>) => selectEntityCandidate(...args)) as unknown as Parameters<typeof createTaskReadService>[0]['selectEntityCandidate'],
  resolveCalendarTemporalScope: ((...args: Parameters<typeof resolveCalendarTemporalScope>) => resolveCalendarTemporalScope(...args)) as unknown as Parameters<typeof createTaskReadService>[0]['resolveCalendarTemporalScope'],
  formatLocalDateTime: ((...args: Parameters<typeof formatLocalDateTime>) => formatLocalDateTime(...args)) as unknown as Parameters<typeof createTaskReadService>[0]['formatLocalDateTime'],
  parseTaskScope: ((...args: Parameters<typeof parseTaskScope>) => parseTaskScope(...args)) as unknown as Parameters<typeof createTaskReadService>[0]['parseTaskScope'],
  logger: console, getNow: () => new Date()});
export function taskMatchesQuery(...args: Parameters<typeof service.taskMatchesQuery>) { return service.taskMatchesQuery(...args); }
export function getTaskList(...args: Parameters<typeof service.getTaskList>) { return service.getTaskList(...args); }


