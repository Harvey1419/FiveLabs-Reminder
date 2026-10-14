/** Synthetic provider protocol fixtures; no domain execution or semantic grading. */
export const reminderContinuity = [
  {
    name: 'create', prompt: 'Recordame llamar a Ana hoy a las 4 PM', tool: 'reminder_create',
    arguments: { content: 'Llamar a Ana', targetTimeIso: '2026-10-11T21:00:00Z' },
    result: { reminderId: 'fixture-reminder-1', scheduledAt: '2026-10-11T21:00:00Z' },
  },
  {
    name: 'update', prompt: 'Muévelo media hora', tool: 'reminder_update',
    arguments: { reminderId: 'fixture-reminder-1', targetTimeIso: '2026-10-11T21:30:00Z' },
    result: { reminderId: 'fixture-reminder-1', scheduledAt: '2026-10-11T21:30:00Z' },
  },
  {
    name: 'acknowledge', prompt: 'Ya lo hice', tool: 'reminder_acknowledge',
    arguments: { reminderId: 'fixture-reminder-1' },
    result: { reminderId: 'fixture-reminder-1', acknowledged: true },
  },
] as const;
