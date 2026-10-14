import { z } from 'zod';
import { aiMessageSchema } from './provider.js';
import { reminderRecordSchema, reminderResultSchema } from './reminders.js';

export const reminderToolNameSchema = z.enum(['reminder_create', 'reminder_read', 'reminder_update', 'reminder_acknowledge']);
export const reminderUiItemSchema = z.strictObject({
  callId: z.string().min(1), toolName: reminderToolNameSchema,
  status: z.enum(['success', 'partial', 'validation_failed', 'denied', 'approval_required', 'clarification_required', 'failed', 'indeterminate']),
  code: z.string().max(80).nullable(), result: reminderResultSchema.nullable(),
  // Validated read scope belongs to the request, not model-authored prose.
  readFilter: z.string().max(100).nullable(), readQuery: z.string().max(200).nullable(),
});
export const reminderUiPayloadSchema = z.strictObject({
  language: z.enum(['es', 'en']), timezone: z.string().min(1),
  items: z.array(reminderUiItemSchema).max(10),
  notices: z.array(z.enum(['provider_unavailable', 'invalid_response', 'unavailable_tool', 'limit_reached'])).max(10),
});
export type ReminderUiPayload = z.infer<typeof reminderUiPayloadSchema>;
export type ReminderUiItem = z.infer<typeof reminderUiItemSchema>;

export const reminderConversationSchema = z.strictObject({
  userId: z.string().min(1),
  history: z.array(aiMessageSchema),
  references: z.array(reminderRecordSchema).max(50),
  handledRequestIds: z.array(z.string().min(1)).max(100),
});
export type ReminderConversation = z.infer<typeof reminderConversationSchema>;
