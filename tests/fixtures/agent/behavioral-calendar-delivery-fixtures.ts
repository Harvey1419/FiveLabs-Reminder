import { behavioralStructuredMessage } from './behavioral-read-fixtures.js';

const event = { operation: 'calendar.create', title: 'Reunión de trabajo',
  schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 9, minute: 0, clockMode: 'explicit_24h' },
  durationMinutes: 60 } as const;
export const behavioralCalendarDeliveryActions = {
  calendarWithNotice: { ...event, advanceMinutes: 15 },
  calendarWithoutNotice: event,
  advanceExisting: { operation: 'reminder.update', contextRef: { source: 'working_memory', position: 1 },
    deliveryPolicy: { advanceNotice: 'offset', advanceMinutes: 15 } },
  upcomingAgenda: { operation: 'agenda.read', scope: 'upcoming' },
} as const;

export function behavioralCalendarDeliveryMessage(key: keyof typeof behavioralCalendarDeliveryActions) {
  return behavioralStructuredMessage([behavioralCalendarDeliveryActions[key]]);
}
