import { behavioralStructuredMessage } from './behavioral-read-fixtures.js';
export const activeNoticeActions = {
  acknowledgeActive: { operation: 'reminder.acknowledge' },
  acknowledgeNamed: { operation: 'reminder.acknowledge', target: 'Comprar fruta' },
  missingDatedEvent: { operation: 'calendar.update', scope: '2026-09-09', target: 'cita', title: 'Reunión en Cerámica Italia' },
} as const;
export function activeNoticeMessage(key: keyof typeof activeNoticeActions, responseLanguage: 'es' | 'en' = 'es') {
  return behavioralStructuredMessage([activeNoticeActions[key]], { responseLanguage });
}
