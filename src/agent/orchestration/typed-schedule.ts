import { getLocalDateParts, zonedTimeToUtc } from '../../shared/time.js';
import { createScheduleResolver } from './temporal-schedule-resolver.js';
export const { resolveTypedSchedule, mergePendingSchedule } = createScheduleResolver({
  getLocalDateParts: (...args) => getLocalDateParts(...args),
  zonedTimeToUtc: (...args) => zonedTimeToUtc(...args),
});


