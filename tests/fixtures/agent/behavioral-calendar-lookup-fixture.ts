import { behavioralStructuredMessage } from './behavioral-read-fixtures.js';
export const datedCalendarRename = { operation: 'calendar.update', scope: '2026-09-09', target: 'cita',
  title: 'Reunión en Ceramica italia de barranquilla' } as const;
export function datedCalendarRenameMessage() { return behavioralStructuredMessage([datedCalendarRename]); }
