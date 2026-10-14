import { behavioralStructuredMessage } from './behavioral-read-fixtures.js';
export const noticeWeekdayActions = {
  acknowledgeNotification: { operation: 'reminder.acknowledge' },
  repeatBathroom: { operation: 'reminder.acknowledge', target: 'Ir al baño' },
  fridayAgenda: { operation: 'agenda.read', scope: 'friday' },
} as const;
export function noticeWeekdayMessage(key: keyof typeof noticeWeekdayActions) {
  return behavioralStructuredMessage([noticeWeekdayActions[key]]);
}
