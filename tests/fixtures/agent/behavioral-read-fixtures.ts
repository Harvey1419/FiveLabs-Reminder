import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { completeFixtureWire } from '../../../scripts/evals/groq-contract/baseline.js';

export const behavioralReadActions = {
  agendaTomorrow: { operation: 'agenda.read', scope: 'tomorrow' },
  calendarTomorrow: { operation: 'calendar.list', scope: 'tomorrow' },
  reminderList: { operation: 'reminder.list' },
  taskList: { operation: 'task.list', status: 'all' },
} as const;

/** Model the strict nullable wire, before the foreground validator projects it. */
export function behavioralReadMessage(key: keyof typeof behavioralReadActions) {
  return behavioralStructuredMessage([behavioralReadActions[key]]);
}

export function behavioralStructuredMessage(actions: readonly unknown[], metadata: { answerFromResults?: boolean; responseLanguage?: 'es' | 'en' } = {}) {
  const schema = getStructuredTurnSchema();
  const wire = completeFixtureWire({
    responseLanguage: 'es', responseCapability: 'general', learningCandidates: [],
    ...metadata, actions,
  }, schema as Parameters<typeof completeFixtureWire>[1]);
  return { role: 'assistant' as const, content: JSON.stringify(wire), tool_calls: [] };
}
