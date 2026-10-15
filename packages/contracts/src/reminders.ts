import { z } from 'zod';

const content = z.string().trim().min(1).max(2000);
const instant = z.iso.datetime({ offset: true });
const recurrence = z.string().trim().min(1).max(200);

export const reminderCreateInputSchema = z.strictObject({
  content,
  targetTimeIso: instant,
  advanceMinutes: z.number().int().positive().max(525600).optional(),
  recurrence: recurrence.optional(),
  requiresConfirmation: z.boolean().optional(),
  nudgeIntervalMinutes: z.number().int().positive().max(10080).optional(),
  maxNudges: z.number().int().positive().max(100).optional(),
});
/** Model-facing alternatives; domain persistence still receives one certified ISO instant. */
export const reminderCreateToolInputSchema = reminderCreateInputSchema.omit({ targetTimeIso: true }).extend({
  targetTimeIso: instant.describe('Only explicit dates, AM/PM or unambiguous 24-hour times. For a bare clock hour use unqualifiedLocalTime.').optional(),
  delayMinutes: z.number().int().positive().max(525600).optional(),
  unqualifiedLocalTime: z.strictObject({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) })
    .describe('Clock without date or AM/PM; 12-hour or 24-hour numeric representation is accepted. The host normalizes the half-day and chooses the earliest future occurrence in the user timezone.').optional(),
}).refine(value => [value.targetTimeIso, value.delayMinutes, value.unqualifiedLocalTime].filter(value => value !== undefined).length === 1,
  { message: 'Provide exactly one of targetTimeIso, delayMinutes or unqualifiedLocalTime', path: ['targetTimeIso'] });
export const reminderReadInputSchema = z.strictObject({
  filter: z.union([
    z.enum(['upcoming', 'all_pending', 'today', 'pending_today', 'remaining_today',
      'completed_today', 'created_today', 'tomorrow', 'this_week', 'next_week']),
    z.iso.date(),
  ]).optional(),
  query: z.string().trim().min(1).max(200).refine(value => !value.includes('*') && !value.includes('\0'), {
    message: 'Literal search cannot contain wildcard * or NUL',
  }).optional(),
});
export const reminderUpdateInputSchema = z.strictObject({
  reminderId: z.uuid(),
  content: content.optional(),
  targetTimeIso: instant.optional(),
  recurrence: recurrence.nullable().optional(),
  deliveryPolicy: z.discriminatedUnion('advanceNotice', [
    z.strictObject({ advanceNotice: z.literal('none') }),
    z.strictObject({ advanceNotice: z.literal('offset'), advanceMinutes: z.number().int().positive().max(525600) }),
  ]).optional(),
}).refine(value => value.content !== undefined || value.targetTimeIso !== undefined
  || value.recurrence !== undefined || value.deliveryPolicy !== undefined, {
  message: 'At least one update is required',
});
export const reminderCancelInputSchema = z.strictObject({ reminderId: z.uuid() });
export const reminderAcknowledgeInputSchema = z.strictObject({ reminderId: z.uuid() });

export const reminderRecordSchema = z.strictObject({
  id: z.string().min(1).max(128),
  content: z.string().max(2000),
  sendAt: instant.nullable(),
  recurrence: z.string().max(200).nullable(),
  isAdvanceNotice: z.boolean(),
  parentReminderId: z.string().min(1).max(128).nullable(),
  requiresConfirmation: z.boolean(),
  acknowledgedAt: instant.nullable(),
  status: z.enum(['pending', 'sent', 'failed', 'cancelled']).optional(),
});
export const reminderResultSchema = z.strictObject({
  operation: z.enum(['create', 'read', 'update', 'acknowledge', 'cancel']),
  records: z.array(reminderRecordSchema).max(50),
  complete: z.boolean(),
  coverage: z.enum(['operation', 'bounded_list']),
  rejections: z.array(z.strictObject({ code: z.string().min(1).max(80), reason: z.string().max(4000) })).max(10),
  presentation: z.strictObject({
    canonicalCard: z.string().max(20000).nullable(),
    questions: z.array(z.string().max(4000)).max(10),
    cta: z.strictObject({
      url: z.string().max(2000).nullable(),
      header: z.string().max(2000).nullable(),
      buttonText: z.string().max(200).nullable(),
    }).nullable(),
  }),
});
export type ReminderResult = z.infer<typeof reminderResultSchema>;
export type ReminderRecord = z.infer<typeof reminderRecordSchema>;
export type ReminderRequest =
  | { readonly operation: 'create'; readonly input: z.infer<typeof reminderCreateInputSchema> }
  | { readonly operation: 'read'; readonly input: z.infer<typeof reminderReadInputSchema> }
  | { readonly operation: 'update'; readonly input: z.infer<typeof reminderUpdateInputSchema> }
  | { readonly operation: 'cancel'; readonly input: z.infer<typeof reminderCancelInputSchema> }
  | { readonly operation: 'acknowledge'; readonly input: z.infer<typeof reminderAcknowledgeInputSchema> };
