import { behavioralStructuredMessage } from './behavioral-read-fixtures.js';

export const behavioralFollowupActions = {
  calendarBirthdays: { operation: 'calendar.search', scope: 'full_year', query: 'cumpleaños' },
  memoryInventory: { operation: 'memory.list', limit: 5 },
  acknowledgeVeterinary: { operation: 'reminder.acknowledge', target: 'veterinaria' },
  acknowledgeBandage: { operation: 'reminder.acknowledge', target: 'vendaje' },
  ambiguousDoctor: { operation: 'reminder.acknowledge', target: 'doctora' },
} as const;

export function behavioralFollowupMessage(key: keyof typeof behavioralFollowupActions) {
  return behavioralStructuredMessage([behavioralFollowupActions[key]]);
}
