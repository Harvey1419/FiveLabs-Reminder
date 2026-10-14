import { behavioralStructuredMessage } from './behavioral-read-fixtures.js';

export const taskCalendarMutationActions = {
  completeNamed: { operation: 'task.complete', target: 'Diseñar el orden BAM para poder tener más dinero con la misma orden' },
  listTasks: { operation: 'task.list', status: 'all' },
  completeSecond: { operation: 'task.complete', contextRef: { source: 'working_memory', position: 2 } },
  fridayCalendar: { operation: 'calendar.list', scope: 'friday' },
  deleteSecond: { operation: 'calendar.delete', contextRef: { source: 'working_memory', position: 2 } },
} as const;

export function taskCalendarMutationMessage(key: keyof typeof taskCalendarMutationActions) {
  return behavioralStructuredMessage([taskCalendarMutationActions[key]]);
}
