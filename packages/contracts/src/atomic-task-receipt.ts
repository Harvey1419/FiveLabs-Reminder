import { z } from 'zod';
import { jsonObjectSchema } from './provider.js';
import { productivityItemSchema } from './productivity-turn.js';
export const atomicTaskCallSchema = z.strictObject({ toolName: z.literal('manage_task'),
  params: z.strictObject({ action: z.enum(['complete', 'delete']), target: z.uuid() }) });
export const atomicTaskReceiptSchema = z.strictObject({
  version: z.literal(1), receiptId: z.uuid(), userId: z.uuid(), activeRunId: z.uuid(), inboundRunId: z.uuid(), claimId: z.uuid(),
  threadId: z.string().min(1), callId: z.string().min(1).max(256), targetId: z.uuid(), domainCall: atomicTaskCallSchema,
  item: productivityItemSchema, legacyResult: jsonObjectSchema,
  companionReminderIds: z.array(z.uuid()).max(100),
}).superRefine((receipt, ctx) => {
  if (receipt.item.domain !== 'tasks' || receipt.item.callId !== receipt.callId || receipt.item.status !== 'success'
    || !receipt.item.result?.complete || receipt.item.result.operation !== receipt.domainCall.params.action
    || receipt.targetId !== receipt.domainCall.params.target || receipt.item.result.records.length !== 1
    || receipt.item.result.records[0]?.id !== receipt.targetId || receipt.legacyResult.success !== true
    || receipt.item.result.records[0]?.status !== (receipt.domainCall.params.action === 'complete' ? 'completed' : 'deleted')
    || receipt.legacyResult.action !== (receipt.domainCall.params.action === 'complete' ? 'completed_task' : 'deleted_task')
    || jsonObjectSchema.safeParse(receipt.legacyResult.data).data?.id !== receipt.targetId
    || new Set(receipt.companionReminderIds).size !== receipt.companionReminderIds.length) {
    ctx.addIssue({ code: 'custom', message: 'Atomic task receipt must establish the exact complete mutation' });
  }
});
export type AtomicTaskReceipt = z.infer<typeof atomicTaskReceiptSchema>;
