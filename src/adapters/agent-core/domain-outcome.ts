import { z } from 'zod';
import { domainPresentationSchema, jsonObjectSchema, type JsonObject, type TurnContext } from '@templelabs/contracts';
import type { ToolOutcome } from '@templelabs/tools';



export const domainEnvelopeSchema = z.looseObject({
  success: z.boolean(), action: z.string(), outcome: z.literal('unknown').optional(),
  complete: z.boolean().optional(), partialSuccess: z.boolean().optional(),
  errorCode: z.string().optional(), requiresClarification: z.boolean().optional(),
  data: z.unknown().optional(), flow: z.unknown().optional(),
  confirmation: z.string().nullish(), formattedCard: z.string().nullish(), rawSummary: z.string().nullish(),
  ctaUrl: z.string().nullish(), ctaHeader: z.string().nullish(), ctaButtonText: z.string().nullish(),
});
export type DomainEnvelope = z.infer<typeof domainEnvelopeSchema>;
export const objectSchema = z.record(z.string(), z.unknown());
export function nullableString(value: unknown): string | null {
  return value == null ? null : z.string().parse(value);
}
export function definedJson(value: Record<string, unknown>): JsonObject {
  return jsonObjectSchema.parse(Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)));
}
export function presentation(result: DomainEnvelope) {
  const card = result.confirmation ?? result.formattedCard ?? result.rawSummary ?? null;
  return domainPresentationSchema.parse({
    canonicalCard: card,
    questions: result.requiresClarification && card ? [card] : [],
    cta: result.ctaUrl ? { url: result.ctaUrl, header: result.ctaHeader ?? null, buttonText: result.ctaButtonText ?? null } : null,
  });
}
const noEffectCodes = new Set([
  'ACCESS_DENIED', 'NOT_FOUND', 'INVALID_PARAMETERS', 'INVALID_TIME', 'TIME_IN_PAST',
  'MISSING_TARGET_ID', 'UNSUPPORTED_CALENDAR_DURATION', 'INCOMPATIBLE_CALENDAR_PATCH', 'INVALID_CALENDAR_INTERVAL', 'MISSING_REQUIRED_CONTEXT', 'AMBIGUOUS_TARGET', 'AUTH_REQUIRED',
]);
export function failedOutcome<Output>(result: DomainEnvelope, data: Output, observation: string,
  effect: 'read' | 'write', operationId: string): ToolOutcome<Output> {
  const code = noEffectCodes.has(result.errorCode ?? '') ? result.errorCode! : 'DOMAIN_ERROR';
  if (result.outcome === 'unknown') return effect === 'read'
    ? { status: 'failed', code: 'READ_UNAVAILABLE', observation: 'The read result could not be verified.' }
    : { status: 'indeterminate', operationId, observation: 'Reconcile the unknown action outcome before retrying.' };
  if (result.requiresClarification || code === 'AMBIGUOUS_TARGET' || code === 'MISSING_REQUIRED_CONTEXT') {
    return { status: 'clarification_required', code, data, observation };
  }
  if (code === 'ACCESS_DENIED') return { status: 'denied', code, data, observation };
  if (code === 'AUTH_REQUIRED') return { status: 'approval_required', code, data, observation };
  if (effect === 'write' && !noEffectCodes.has(code)) {
    return { status: 'indeterminate', operationId, observation: 'The action may have committed. Reconcile before retrying.' };
  }
  return { status: 'failed', code, data, observation };
}

export function checkDomainContext(userId: string, context: TurnContext): ToolOutcome<never> | null {
  if (context.userId !== userId) return { status: 'denied', code: 'OWNER_MISMATCH', observation: 'The domain owner does not match this turn.' };
  if (!Number.isFinite(Date.parse(context.referenceTimeIso))) return { status: 'validation_failed', code: 'INVALID_REFERENCE_TIME', observation: 'A valid turn reference is required.' };
  try { new Intl.DateTimeFormat('en', { timeZone: context.timezone }).format(); }
  catch { return { status: 'validation_failed', code: 'INVALID_TIMEZONE', observation: 'A valid IANA timezone is required.' }; }
  return null;
}
