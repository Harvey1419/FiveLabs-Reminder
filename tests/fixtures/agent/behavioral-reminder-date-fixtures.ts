import { behavioralStructuredMessage } from './behavioral-read-fixtures.js';
export const reminderDateActions = {
  pendingToday: { operation: 'reminder.list', filter: 'pending_today' },
  createdToday: { operation: 'reminder.list', filter: 'created_today' },
  completedToday: { operation: 'reminder.list', filter: 'completed_today' },
  remainingToday: { operation: 'reminder.list', filter: 'remaining_today' },
} as const;
export function reminderDateMessage(key: keyof typeof reminderDateActions) {
  return behavioralStructuredMessage([reminderDateActions[key]]);
}
