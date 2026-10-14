import { z } from 'zod';
import { jsonObjectSchema } from './provider.js';
import { productivityToolNameSchema } from './productivity-turn.js';
import { reminderToolNameSchema } from './reminder-turn.js';

const operation = z.strictObject({
  callId: z.string().min(1), toolName: reminderToolNameSchema,
  arguments: jsonObjectSchema,
  status: z.enum(['approval_required', 'clarification_required', 'indeterminate', 'success', 'partial']),
});
/** Historical protocol facts, never fresh database evidence or authorization. */
export const reminderOperationalSummarySchema = z.strictObject({
  version: z.literal(1), userId: z.string().min(1),
  provenance: z.literal('host_owned_tool_transcript'),
  freshness: z.literal('historical'), grantsAuthorization: z.literal(false),
  omittedMessages: z.number().int().positive(),
  pending: z.array(operation.extend({
    questions: z.array(z.string().max(500)).max(3),
  })).max(1000),
  recentConfirmed: z.array(operation).max(5),
});
export type ReminderOperationalSummary = z.infer<typeof reminderOperationalSummarySchema>;

const productivityOperation = operation.extend({ toolName: productivityToolNameSchema });
export const productivityOperationalSummarySchema = reminderOperationalSummarySchema.extend({
  pending: z.array(productivityOperation.extend({ questions: z.array(z.string().max(500)).max(3) })).max(1000),
  recentConfirmed: z.array(productivityOperation).max(5),
});
export type ProductivityOperationalSummary = z.infer<typeof productivityOperationalSummarySchema>;
