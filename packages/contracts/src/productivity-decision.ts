import { z } from 'zod';
import { jsonObjectSchema } from './provider.js';

export const productivityClarificationSchema = z.strictObject({
  domain: z.enum(['reminders', 'tasks', 'calendar', 'memories', 'general']),
  missing: z.enum(['date', 'time', 'item', 'details', 'today_or_tomorrow']),
});
export type ProductivityClarification = z.infer<typeof productivityClarificationSchema>;
const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const decisionItemKeySchema = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/);
/** Partial proposed arguments, never an executable command or authorization. */
const knownArguments = jsonObjectSchema.superRefine((value, ctx) => {
  const bounded = (entry: unknown, depth: number): boolean => depth <= 4 && (entry === null || typeof entry !== 'object'
    || Object.entries(entry).every(([key, child]) => !['__proto__', 'constructor', 'prototype', 'decisionItem', 'turnDisposition'].includes(key)
      && bounded(child, depth + 1)));
  if (JSON.stringify(value).length > 1000 || !bounded(value, 0)) ctx.addIssue({ code: 'custom', message: 'Pending facts exceed their bounded data-only scope' });
});
export const pendingDecisionSchema = z.strictObject({
  tool: name, missing: productivityClarificationSchema.shape.missing, knownArguments,
});
export const productivityDecisionSchema = z.strictObject({
  ready: z.array(z.strictObject({ key: decisionItemKeySchema, tool: name })).max(10),
  pending: pendingDecisionSchema.optional(),
  resolution: z.strictObject({ pendingId: z.string().min(1).max(512), key: decisionItemKeySchema }).optional(),
  reply: z.string().trim().min(1).max(1200).optional(),
}).superRefine((decision, ctx) => {
  if (new Set(decision.ready.map(item => item.key)).size !== decision.ready.length
    || decision.reply && (decision.ready.length > 0 || decision.pending || decision.resolution)
    || !decision.ready.length && !decision.pending && !decision.reply
    || decision.resolution && (decision.ready.length !== 1 || decision.ready[0]?.key !== decision.resolution.key || decision.pending)) {
    ctx.addIssue({ code: 'custom', message: 'Decision must separate ready work, one clarification, and non-execution dialogue' });
  }
});
export const productivityPendingSchema = pendingDecisionSchema.extend({
  id: z.string().min(1).max(512), userId: z.string().min(1), sourceRequestId: z.string().min(1),
  sourceContext: z.strictObject({ referenceTimeIso: z.iso.datetime({ offset: true }), timezone: z.string().min(1).max(100) }).optional(),
});
export type ProductivityDecision = z.infer<typeof productivityDecisionSchema>;
export type ProductivityPending = z.infer<typeof productivityPendingSchema>;
