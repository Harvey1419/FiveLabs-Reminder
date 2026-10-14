import { memoryToolNameSchema, memoryRecordSchema, memoryResultSchema, memoryReadInputSchema } from './memories.js';
import { z } from 'zod';
import { aiMessageSchema } from './provider.js';
import { reminderRecordSchema, reminderResultSchema, reminderReadInputSchema } from './reminders.js';
import { reminderToolNameSchema } from './reminder-turn.js';
import { taskRecordSchema, taskResultSchema, taskReadInputSchema } from './tasks.js';
import { calendarEventSchema, calendarResultSchema, calendarReadInputSchema } from './calendar.js';

export const taskToolNameSchema = z.enum(['task_create', 'task_read', 'task_update', 'task_complete', 'task_delete']);
export const calendarToolNameSchema = z.enum(['calendar_create', 'calendar_read', 'calendar_connect', 'calendar_update', 'calendar_delete']);
export const productivityToolNameSchema = z.enum([...reminderToolNameSchema.options,
  ...taskToolNameSchema.options, ...calendarToolNameSchema.options, ...memoryToolNameSchema.options]);
const common = {
  callId: z.string().min(1),
  status: z.enum(['success', 'partial', 'validation_failed', 'denied', 'approval_required', 'clarification_required', 'failed', 'indeterminate']),
  code: z.string().max(80).nullable(),
};
export const productivityItemSchema = z.discriminatedUnion('domain', [
  z.strictObject({ ...common, domain: z.literal('reminders'), toolName: reminderToolNameSchema, result: reminderResultSchema.nullable(), readScope: reminderReadInputSchema.nullable().optional() }),
  z.strictObject({ ...common, domain: z.literal('tasks'), toolName: taskToolNameSchema, result: taskResultSchema.nullable(), readScope: taskReadInputSchema.nullable().optional() }),
  z.strictObject({ ...common, domain: z.literal('memories'), toolName: memoryToolNameSchema, result: memoryResultSchema.nullable(), readScope: memoryReadInputSchema.nullable().optional() }),
  z.strictObject({ ...common, domain: z.literal('calendar'), toolName: calendarToolNameSchema, result: calendarResultSchema.nullable(), readScope: calendarReadInputSchema.nullable().optional() }),
]).superRefine((item, ctx) => {
  if (item.result && item.toolName !== `${item.domain === 'reminders' ? 'reminder' : item.domain === 'tasks' ? 'task' : item.domain === 'memories' ? 'memory' : 'calendar'}_${item.result.operation}`) {
    ctx.addIssue({ code: 'custom', message: 'Tool and result operation must match' });
  }
  if ((item.status === 'success' || item.status === 'partial') && !item.result) {
    ctx.addIssue({ code: 'custom', message: 'Confirmed outcome requires domain evidence' });
  }
  if (item.status === 'success' && item.result && !item.result.complete) {
    ctx.addIssue({ code: 'custom', message: 'Successful outcome requires complete evidence' });
  }
  if (item.readScope && !item.toolName.endsWith('_read')) {
    ctx.addIssue({ code: 'custom', message: 'Read scope belongs only to read operations' });
  }
});
export const productivityConversationSchema = z.strictObject({
  userId: z.string().min(1), history: z.array(aiMessageSchema),
  legacyHandoff: z.strictObject({ sourceRunId: z.string().min(1), sourceRequestId: z.string().min(1),
    referenceGaps: z.array(z.strictObject({ id: z.string().min(1).max(128), type: z.string().min(1).max(50),
      position: z.number().int().positive(), title: z.string().max(200).nullable(), reason: z.enum(['missing', 'unsupported']) })).max(51),
  }).optional(),
  referenceOrder: z.array(z.strictObject({ domain: z.enum(['tasks', 'reminders', 'calendar', 'memories']), id: z.string().min(1), position: z.number().int().positive() })).max(51).optional(),
  memoryReferenceOrder: z.array(z.uuid()).max(50).optional(),
  memories: z.array(memoryRecordSchema).max(50).optional(),
  reminders: z.array(reminderRecordSchema).max(50), tasks: z.array(taskRecordSchema).max(50),
  events: z.array(calendarEventSchema).max(50), handledRequestIds: z.array(z.string().min(1)).max(100),
});
/** Free dialogue is separate from execution narration, whose facts belong to the presenter. */
export const productivityDialogueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('conversation'), content: z.string().min(1).max(4000) }),
  z.strictObject({ kind: z.literal('execution'), tone: z.enum(['neutral', 'supportive']) }),
]);
export const productivityUiPayloadSchema = z.strictObject({
  language: z.enum(['es', 'en']), timezone: z.string().min(1), conversationReply: z.string().max(4000).nullable().optional(), items: z.array(productivityItemSchema).max(10),
  dialogue: productivityDialogueSchema.optional(),
  notices: z.array(z.enum(['provider_unavailable', 'invalid_response', 'unavailable_tool', 'limit_reached'])).max(10),
});
export type ProductivityItem = z.infer<typeof productivityItemSchema>;
export type ProductivityConversation = z.infer<typeof productivityConversationSchema>;
export type ProductivityUiPayload = z.infer<typeof productivityUiPayloadSchema>;
