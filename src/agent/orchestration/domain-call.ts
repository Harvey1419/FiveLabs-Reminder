// Legacy context/temporal wiring; domain request construction executes from TypeScript.
import { normalizeReminderQuery } from '../contracts/reminder-query.js';
import { getWorkingMemory } from '../core/working-memory-store.js';
import { resolveContextReference } from '../core/context-reference.js';
import { normalizeAgendaScope } from '../../shared/agenda-scopes.js';
import { resolveTypedSchedule } from './typed-schedule.js';
import { formatAssistantClarification } from './clarification-presentation.js';
import { normalizeTurnActionForRuntime } from './intent-normalizer.js';
import { detectLanguageFromText } from '../../shared/language-detection.js';
import { createDomainCallBuilder } from './domain-call-builder.js';
export const { buildDomainCall,failedResult,intentTarget } = createDomainCallBuilder({
  normalizeReminderQuery: ((...args: Parameters<typeof normalizeReminderQuery>) => normalizeReminderQuery(...args)) as unknown as Parameters<typeof createDomainCallBuilder>[0]['normalizeReminderQuery'],
  getWorkingMemory: ((...args: Parameters<typeof getWorkingMemory>) => getWorkingMemory(...args)) as unknown as Parameters<typeof createDomainCallBuilder>[0]['getWorkingMemory'],
  resolveContextReference: ((...args: Parameters<typeof resolveContextReference>) => resolveContextReference(...args)) as unknown as Parameters<typeof createDomainCallBuilder>[0]['resolveContextReference'],
  normalizeAgendaScope: ((...args: Parameters<typeof normalizeAgendaScope>) => normalizeAgendaScope(...args)) as unknown as Parameters<typeof createDomainCallBuilder>[0]['normalizeAgendaScope'],
  resolveTypedSchedule: ((...args: Parameters<typeof resolveTypedSchedule>) => resolveTypedSchedule(...args)) as unknown as Parameters<typeof createDomainCallBuilder>[0]['resolveTypedSchedule'],
  formatAssistantClarification: ((...args: Parameters<typeof formatAssistantClarification>) => formatAssistantClarification(...args)) as unknown as Parameters<typeof createDomainCallBuilder>[0]['formatAssistantClarification'],
  normalizeTurnActionForRuntime: ((...args: Parameters<typeof normalizeTurnActionForRuntime>) => normalizeTurnActionForRuntime(...args)) as unknown as Parameters<typeof createDomainCallBuilder>[0]['normalizeTurnActionForRuntime'],
  detectLanguageFromText: ((...args: Parameters<typeof detectLanguageFromText>) => detectLanguageFromText(...args)) as unknown as Parameters<typeof createDomainCallBuilder>[0]['detectLanguageFromText'],
});


