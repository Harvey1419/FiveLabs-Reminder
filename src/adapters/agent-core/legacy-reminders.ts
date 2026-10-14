import { z } from 'zod';
import {
  jsonObjectSchema, reminderResultSchema,
  type JsonObject, type ReminderRecord, type ReminderRequest, type ReminderResult, type TurnContext,
} from '@templelabs/contracts';
import type { ReminderDomainPort, ToolOutcome } from '@templelabs/tools';
import type { LegacyToolRequest, LegacyToolUser } from '../../agent/tools/index.js';
import { parseTargetTime } from '../../shared/time.js';

const legacyResultSchema = z.looseObject({
  success: z.boolean(), action: z.string(), outcome: z.literal('unknown').optional(),
  complete: z.boolean().optional(), partialSuccess: z.boolean().optional(),
  errorCode: z.string().optional(), requiresClarification: z.boolean().optional(),
  data: z.unknown().optional(), pendingClarifications: z.array(z.unknown()).optional(),
  confirmation: z.string().nullish(), formattedCard: z.string().nullish(), rawSummary: z.string().nullish(),
  ctaUrl: z.string().nullish(), ctaHeader: z.string().nullish(), ctaButtonText: z.string().nullish(),
});
const objectSchema = z.record(z.string(), z.unknown());
const noEffectCodes = new Set([
  'ACCESS_DENIED', 'PRO_TIER_REQUIRED', 'NOT_FOUND', 'INVALID_PARAMETERS',
  'INVALID_QUERY', 'INVALID_TIME', 'INVALID_TIME_FORMAT', 'TIME_IN_PAST',
  'MISSING_REQUIRED_CONTEXT', 'AMBIGUOUS_TARGET', 'MISSING_TARGET', 'MISSING_TARGET_ID',
]);
const expectedActions = {
  create: new Set(['created_reminders_batch', 'partially_created_reminders']),
  read: new Set(['listed_reminders']), update: new Set(['updated_reminder']),
  acknowledge: new Set(['acknowledged_reminder']), cancel: new Set(['cancelled_reminder', 'cancelled_recurring_reminder_series']),
};
const toolNames = {
  create: 'reminder_create', read: 'reminder_read', update: 'reminder_update', acknowledge: 'reminder_acknowledge', cancel: 'reminder_cancel',
};

function optionalString(value: unknown): string | null {
  return value == null ? null : z.string().parse(value);
}

export function normalizeLegacyReminderRecord(value: unknown): ReminderRecord {
  const row = objectSchema.parse(value);
  return {
    id: z.string().min(1).parse(row.id),
    content: z.string().parse(row.content ?? row.title ?? ''),
    sendAt: optionalString(row.sendAt ?? row.send_at),
    recurrence: optionalString(row.recurrenceRule ?? row.recurrence_rule),
    isAdvanceNotice: row.isAdvanceNotice === true || row.source === 'advance_notice',
    parentReminderId: optionalString(row.parentReminderId ?? row.parent_reminder_id),
    requiresConfirmation: row.requiresConfirmation === true || row.requires_confirmation === true,
    acknowledgedAt: optionalString(row.acknowledged_at),
    ...(row.status === 'cancelled' ? { status: 'cancelled' as const } : {}),
  };
}
const normalizeRecord = normalizeLegacyReminderRecord;

function canonicalTime(value: string, context: TurnContext): string {
  const date = parseTargetTime(value, context.timezone, new Date(context.referenceTimeIso));
  if (!date || !Number.isFinite(date.getTime())) throw new Error('Invalid temporal result');
  return date.toISOString();
}

function legacyParams(request: ReminderRequest, context: TurnContext): JsonObject {
  const input = request.input;
  switch (request.operation) {
    case 'create': {
      const { targetTimeIso, ...policy } = request.input;
      const definedPolicy = Object.fromEntries(Object.entries(policy).filter(([, value]) => value !== undefined));
      return jsonObjectSchema.parse({ action: 'create', items: [{ ...definedPolicy, targetTime: canonicalTime(targetTimeIso, context) }] });
    }
    case 'read': return jsonObjectSchema.parse({ action: 'list', ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) });
    case 'update': {
      const changes = request.input;
      const updates: JsonObject = {};
      if (changes.content !== undefined) updates.content = changes.content;
      if (changes.targetTimeIso !== undefined) updates.targetTime = canonicalTime(changes.targetTimeIso, context);
      if (changes.recurrence !== undefined) updates.recurrence = changes.recurrence;
      return {
        action: 'update', target: changes.reminderId, updates,
        ...(changes.deliveryPolicy ? { deliveryPolicy: changes.deliveryPolicy } : {}),
      };
    }
    case 'cancel': return { action: 'cancel', target: request.input.reminderId };
    case 'acknowledge': return { action: 'acknowledge', reminderId: request.input.reminderId };
  }
}

function normalizeOutcome(raw: unknown, operation: ReminderRequest['operation'], context: TurnContext, operationId: string): ToolOutcome<ReminderResult> {
  const result = legacyResultSchema.parse(raw);
  const indeterminate = (): ToolOutcome<ReminderResult> => ({
    status: 'indeterminate', operationId,
    observation: 'The action outcome is unknown. Reconcile this operation before retrying.',
  });
  if (result.outcome === 'unknown') return operation === 'read'
    ? { status: 'failed', code: 'READ_UNAVAILABLE', observation: 'The reminder read could not be verified.' }
    : indeterminate();
  if (result.success && !expectedActions[operation].has(result.action)) throw new Error('Unexpected domain action');

  const dataObject = !Array.isArray(result.data) && result.data != null ? objectSchema.parse(result.data) : {};
  const alreadyInactive = operation === 'cancel' && result.action === 'reminder_already_inactive' && result.complete === true;
  const hasEffects = result.success || result.partialSuccess === true;
  if (alreadyInactive) return { status: 'failed', code: 'ALREADY_INACTIVE', observation: 'The reminder is already inactive; no cancellation write was made.' };
  let rows: unknown[] = [];
  if (hasEffects) {
    if (operation === 'create') rows = z.array(z.unknown()).parse(Array.isArray(result.data) ? result.data : dataObject.items);
    else if (operation === 'cancel') rows = z.array(z.unknown()).parse(dataObject.cancelledReminders);
    else if (operation === 'read') rows = z.array(z.unknown()).parse(dataObject.reminders);
    else rows = [dataObject.reminder ?? result.data];
    if (operation !== 'read' && rows.length === 0) throw new Error('Write reported success without resource evidence');
  }
  const records = rows.slice(0, 50).map(normalizeRecord);
  const rejections = z.array(z.unknown()).parse(dataObject.rejected ?? []).map(value => {
    const item = objectSchema.parse(value);
    const code = optionalString(item.code) ?? 'DOMAIN_ERROR';
    return { code, reason: optionalString(item.reason) ?? 'The requested action could not be completed.' };
  });
  const questions = (result.pendingClarifications ?? z.array(z.unknown()).parse(dataObject.pendingClarifications ?? []))
    .map(value => optionalString(objectSchema.parse(value).question)).filter((value): value is string => value !== null);
  const complete = result.success && result.complete !== false && !result.partialSuccess && rejections.length === 0;
  const data = reminderResultSchema.parse({
    operation, records, complete, coverage: operation === 'read' ? 'bounded_list' : 'operation', rejections,
    presentation: {
      canonicalCard: result.confirmation ?? result.formattedCard ?? result.rawSummary ?? null, questions,
      cta: result.ctaUrl ? { url: result.ctaUrl, header: result.ctaHeader ?? null, buttonText: result.ctaButtonText ?? null } : null,
    },
  });
  const observation = JSON.stringify({
    operation, complete, coverage: data.coverage, returnedCount: records.length,
    shownCount: Math.min(records.length, 5), records: records.slice(0, 5),
    rejectionCount: rejections.length, clarificationRequired: result.requiresClarification === true,
    errorCode: noEffectCodes.has(result.errorCode ?? '') ? result.errorCode : null,
    questions: questions.slice(0, 3).map(question => question.slice(0, 500)),
  });
  if (hasEffects) return {
    status: complete ? 'success' : 'partial', data, observation,
    receipt: { userId: context.userId, operationId, toolName: toolNames[operation], resourceIds: records.map(row => row.id) },
  };
  const code = result.errorCode ?? 'DOMAIN_ERROR';
  if (result.requiresClarification) return { status: 'clarification_required', code, data, observation };
  if (code === 'ACCESS_DENIED' || code === 'PRO_TIER_REQUIRED') return { status: 'denied', code, data, observation };
  if (operation !== 'read' && !noEffectCodes.has(code)) return indeterminate();
  return { status: 'failed', code, data, observation };
}

/** Composition adapter: existing executor remains the only domain mutation path. */
export function createLegacyReminderPort(
  authenticatedUser: LegacyToolUser,
  execute: (request: LegacyToolRequest) => Promise<unknown> = async request => (await import('../../agent/tools/index.js')).executeTool(request),
): ReminderDomainPort {
  const user = { ...authenticatedUser };
  return {
    async execute(request, context, operationId) {
      if (context.userId !== user.id) return { status: 'denied', code: 'OWNER_MISMATCH', observation: 'The reminder owner does not match this turn.' };
      if (!Number.isFinite(new Date(context.referenceTimeIso).getTime())) return { status: 'validation_failed', code: 'INVALID_REFERENCE_TIME', observation: 'A valid turn reference instant is required.' };
      try { new Intl.DateTimeFormat('en', { timeZone: context.timezone }).format(); }
      catch { return { status: 'validation_failed', code: 'INVALID_TIMEZONE', observation: 'A valid IANA timezone is required.' }; }
      const params = legacyParams(request, context);
      context.signal.throwIfAborted();
      const result = await execute({
        toolName: 'manage_reminder', params,
        user: { ...user, timezone: context.timezone, locale: context.language === 'en' ? 'en-US' : 'es-CO' },
        isPro: context.capabilities.has('reminders.pro'), language: context.language,
        correlationId: context.requestId, referenceTime: new Date(context.referenceTimeIso),
      });
      return normalizeOutcome(result, request.operation, context, operationId);
    },
  };
}
