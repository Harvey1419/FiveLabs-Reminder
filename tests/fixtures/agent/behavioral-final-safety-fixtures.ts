import { behavioralStructuredMessage } from './behavioral-read-fixtures.js';

export const finalSafetyActions = {
  ambiguousTask: { operation: 'task.complete', target: 'reporte financiero Q3' },
  datedEmptyCalendar: { operation: 'calendar.list', schedule: { kind: 'calendar_date_time', year: 2026, month: 9, day: 15, allDay: true } },
  completeDisplayed: { operation: 'task.complete', contextRef: { source: 'working_memory', position: 1 } },
} as const;

export function finalSafetyMessage(key: keyof typeof finalSafetyActions, responseLanguage: 'es' | 'en' = 'es') {
  return behavioralStructuredMessage([finalSafetyActions[key]], { responseLanguage });
}
