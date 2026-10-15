import { agendaReadInputSchema, agendaResultSchema, agendaSectionSchema, agendaResourceIds, agendaSourceComplete,
  type TurnContext, type AgendaResult, type JsonObject } from '@templelabs/contracts';
import { defineTool } from './define-tool.js';
import type { ToolRegistry } from './registry.js';

function agendaDate(scope: string, context: TurnContext): string {
  if (scope !== 'today' && scope !== 'tomorrow') return scope;
  const parts = new Intl.DateTimeFormat('en', { timeZone: context.timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(context.referenceTimeIso));
  const part = (name: string) => Number(parts.find(value => value.type === name)?.value);
  return new Date(Date.UTC(part('year'), part('month') - 1, part('day') + (scope === 'tomorrow' ? 1 : 0))).toISOString().slice(0, 10);
}

/** One read use case, three existing owner-scoped ports. No model call or write. */
export function createAgendaTools(registry: ToolRegistry) {
  return [defineTool({ name: 'agenda_read', effect: 'read', requiredCapability: 'agenda.read',
    description: 'Read the combined agenda: calendar events, pending reminders and pending tasks due on the same local date. Use for general what is planned/what do we have questions. Domain-specific questions use their own read tool. Every source is checked before finishing.',
    inputSchema: agendaReadInputSchema, outputSchema: agendaResultSchema,
    handler: async (input, context, operationId) => {
      const date = agendaDate(input.scope, context);
      const sections = await Promise.all((['calendar', 'reminders', 'tasks'] as const).map(async domain => {
        const toolName = domain === 'calendar' ? 'calendar_read' : domain === 'tasks' ? 'task_read' : 'reminder_read';
        const childId = `${operationId}:${domain}`;
        try {
          const outcome = await registry.execute(toolName, domain === 'reminders' ? { filter: date }
            : { scope: date, ...(domain === 'tasks' ? { status: 'pending', limit: 5 } : {}) }, context, childId);
          if ((outcome.status === 'success' || outcome.status === 'partial') && 'data' in outcome) {
            const section = agendaSectionSchema.parse({ domain, status: outcome.status, code: null, result: outcome.data });
            const records = section.domain === 'calendar' ? section.result?.events : section.result?.records;
            const ids = records?.map(record => record.id) ?? [];
            if (outcome.receipt.userId !== context.userId || outcome.receipt.operationId !== childId || outcome.receipt.toolName !== toolName
              || ids.length !== new Set(ids).size || ids.length !== outcome.receipt.resourceIds.length
              || ids.some(id => !outcome.receipt.resourceIds.includes(id))) throw new Error('Unverified agenda source');
            return agendaSourceComplete(section) ? section : agendaSectionSchema.parse({ ...section, status: 'partial' });
          }
        } catch { /* A failed read never discards the other verified sources. */ }
        return agendaSectionSchema.parse({ domain, status: 'failed', code: 'AGENDA_SOURCE_UNAVAILABLE', result: null });
      }));
      const data: AgendaResult = agendaResultSchema.parse({ operation: 'read', date,
        complete: sections.every(agendaSourceComplete), coverage: 'bounded_list', sections,
        presentation: { canonicalCard: null, questions: [], cta: null } });
      const records = sections.flatMap(section => ((section.domain === 'calendar' ? section.result?.events : section.result?.records) ?? [])
        .map((record): JsonObject => ({ id: record.id, domain: section.domain,
          title: 'summary' in record ? record.summary : 'title' in record ? record.title : record.content,
          time: 'sendAt' in record ? record.sendAt : 'dueDateIso' in record ? record.dueDateIso : 'startIso' in record ? record.startIso : record.startDate })));
      return { status: data.complete ? 'success' as const : 'partial' as const, data,
        receipt: { userId: context.userId, operationId, toolName: 'agenda_read', resourceIds: agendaResourceIds(data) },
        observation: JSON.stringify({ operation: 'read', complete: data.complete, coverage: data.coverage,
          sources: sections.map(section => ({ domain: section.domain, status: section.status, code: section.code })), records }) };
    },
  })] as const;
}
