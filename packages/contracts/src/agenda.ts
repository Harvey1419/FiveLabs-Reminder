import { z } from 'zod';
import { calendarResultSchema } from './calendar.js';
import { taskResultSchema } from './tasks.js';
import { reminderResultSchema } from './reminders.js';
import { domainPresentationSchema } from './domain-results.js';

export const agendaReadInputSchema = z.strictObject({ scope: z.union([z.enum(['today', 'tomorrow']), z.iso.date()]) });
const source = { status: z.enum(['success', 'partial', 'failed', 'denied']), code: z.string().max(80).nullable() };
export const agendaSectionSchema = z.discriminatedUnion('domain', [
  z.strictObject({ ...source, domain: z.literal('calendar'), result: calendarResultSchema.nullable() }),
  z.strictObject({ ...source, domain: z.literal('tasks'), result: taskResultSchema.nullable() }),
  z.strictObject({ ...source, domain: z.literal('reminders'), result: reminderResultSchema.nullable() }),
]);
export function agendaSourceComplete(section: z.infer<typeof agendaSectionSchema>): boolean {
  return section.status === 'success' && section.result?.complete === true
    && section.result.presentation.questions.length === 0
    && (section.domain === 'reminders' ? section.result.rejections.length === 0 : section.result.issues.length === 0)
    && (section.domain !== 'calendar' || section.result.connection !== 'authorization_required');
}
export const agendaResultSchema = z.strictObject({
  operation: z.literal('read'), date: z.iso.date(), complete: z.boolean(), coverage: z.literal('bounded_list'),
  sections: z.array(agendaSectionSchema).length(3), presentation: domainPresentationSchema,
}).superRefine((result, ctx) => {
  if (new Set(result.sections.map(section => section.domain)).size !== 3
    || result.sections.some(section => section.result && section.result.operation !== 'read')
    || result.sections.some(section => section.status === 'success' && !section.result?.complete)
    || result.complete !== result.sections.every(agendaSourceComplete)) {
    ctx.addIssue({ code: 'custom', message: 'Agenda coverage requires three distinct verified read sources' });
  }
});
export type AgendaResult = z.infer<typeof agendaResultSchema>;
export function agendaResourceIds(result: AgendaResult): string[] {
  return result.sections.flatMap(section => (section.domain === 'calendar' ? section.result?.events : section.result?.records)
    ?.map(record => `${section.domain}:${record.id}`) ?? []);
}
