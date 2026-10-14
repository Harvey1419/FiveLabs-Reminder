import { behavioralStructuredMessage } from './behavioral-read-fixtures.js';

export const behavioralContinuityActions = {
  agendaTomorrow: [{ operation: 'agenda.read', scope: 'tomorrow' }],
  earliestReminder: [{ operation: 'reminder.list', filter: 'tomorrow' }],
  cancelFirst: [{ operation: 'reminder.cancel', contextRef: { source: 'working_memory', position: 1 } }],
  compoundCreation: [
    { operation: 'reminder.create', content: 'Llamar al banco',
      schedule: { kind: 'relative_day_time', dayOffset: 0, hour: 17, minute: 0, clockMode: 'explicit_24h' } },
    { operation: 'task.create', title: 'Reporte de finanzas', entityName: 'Proyecto Alfa' },
  ],
  clarificationOnly: [{ operation: 'conversation.reply', content: '¿En qué te puedo colaborar o aclarar? Cuéntame y con gusto revisamos.' }],
} as const;

export function behavioralContinuityMessage(key: keyof typeof behavioralContinuityActions) {
  return behavioralStructuredMessage(behavioralContinuityActions[key],
    key === 'earliestReminder' ? { answerFromResults: true } : {});
}

/** Recorded interpretation cites the current observation, never a fabricated call ID. */
export function earliestReminderObservationMessage(payload: string) {
  const parsed: unknown = JSON.parse(payload);
  if (!parsed || typeof parsed !== 'object' || !('observedReads' in parsed) || !Array.isArray(parsed.observedReads)) {
    throw new Error('Expected current observed reads');
  }
  const read = parsed.observedReads.find((value: unknown) => value !== null && typeof value === 'object'
    && 'tool' in value && value.tool === 'manage_reminder');
  if (!read || typeof read.callId !== 'string') throw new Error('Expected a reminder read call identity');
  return { role: 'assistant' as const, tool_calls: [], content: JSON.stringify({
    kind: 'derived', answer: 'El recordatorio más temprano es la Cita con el dentista a las 8:00 AM.',
    evidenceCallIds: [read.callId], taskClaims: [], taskCoverage: 'not_applicable', knowledgeRefs: null,
  }) };
}

export function observedReadPayload(messages: readonly unknown[]): string {
  for (const message of messages) {
    if (message && typeof message === 'object' && 'role' in message && message.role === 'user'
      && 'content' in message && typeof message.content === 'string') return message.content;
  }
  throw new Error('Expected observed answer payload');
}
