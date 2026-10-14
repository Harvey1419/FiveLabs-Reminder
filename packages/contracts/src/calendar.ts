import { z } from 'zod';
import { domainIssueSchema, domainPresentationSchema, temporalScopeSchema } from './domain-results.js';

const summary = z.string().trim().min(1).max(2000);
const common = {
  summary, description: z.string().max(10000).optional(),
  recurrence: z.enum(['yearly', 'monthly', 'weekly', 'daily', 'weekdays']).optional(),
};
export const calendarCreateInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...common, kind: z.literal('timed'), startIso: z.iso.datetime({ offset: true }),
    endIso: z.iso.datetime({ offset: true }), addGoogleMeet: z.boolean().optional(),
    advanceMinutes: z.number().int().positive().max(525600).optional(),
  }).refine(value => Date.parse(value.endIso) > Date.parse(value.startIso), { message: 'End must follow start' }),
  z.strictObject({
    ...common, kind: z.literal('all_day'), startDate: z.iso.date(), endDateExclusive: z.iso.date(),
  }).refine(value => value.endDateExclusive > value.startDate, { message: 'Exclusive end date must follow start date' }),
]);
export const calendarReadInputSchema = z.strictObject({
  scope: z.union([temporalScopeSchema, z.literal('next_event'), z.iso.date()]).optional(),
  query: z.string().trim().min(1).max(200).optional(),
});
export const calendarConnectInputSchema = z.strictObject({});
export const calendarEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: z.string().min(1).max(1024), summary, kind: z.literal('timed'),
    startIso: z.iso.datetime({ offset: true }), endIso: z.iso.datetime({ offset: true }).nullable(),
    meetLink: z.string().max(2000).nullable(),
  }),
  z.strictObject({
    id: z.string().min(1).max(1024), summary, kind: z.literal('all_day'),
    startDate: z.iso.date(), endDateExclusive: z.iso.date().nullable(),
  }),
]);
export const calendarResultSchema = z.strictObject({
  operation: z.enum(['create', 'read', 'connect']), events: z.array(calendarEventSchema).max(50),
  complete: z.boolean(), coverage: z.enum(['operation', 'bounded_list']),
  connection: z.enum(['connected', 'authorization_required']).nullable(),
  companion: z.enum(['not_requested', 'confirmed', 'unconfirmed']),
  issues: z.array(domainIssueSchema).max(10), presentation: domainPresentationSchema,
});
export type CalendarResult = z.infer<typeof calendarResultSchema>;
export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export type CalendarRequest =
  | { readonly operation: 'create'; readonly input: z.infer<typeof calendarCreateInputSchema> }
  | { readonly operation: 'read'; readonly input: z.infer<typeof calendarReadInputSchema> }
  | { readonly operation: 'connect'; readonly input: z.infer<typeof calendarConnectInputSchema> };
