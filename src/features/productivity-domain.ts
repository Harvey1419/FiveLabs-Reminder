import { z } from 'zod';
import { jsonObjectSchema, type TurnContext } from '@templelabs/contracts';
import { requireInboundTurnLease } from '../agent/core/turn-lease.js';

export interface ProductivityUser { id: string; phone_number?: string; timezone?: string; locale?: string }
export interface ProductivityService<Request> { execute(request: Request, context: TurnContext): Promise<unknown> }

type DefinedFields<T> = T extends object ? {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K]
} & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> } : never;
/** Preserve absent optionals at the domain boundary instead of passing undefined values. */
export function definedFields<T extends object>(value: T): DefinedFields<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as DefinedFields<T>;
}

export async function domainInput(user: ProductivityUser, context: TurnContext) {
  if (context.userId !== user.id) throw new Error('DOMAIN_OWNER_MISMATCH');
  context.signal.throwIfAborted();
  const lease = requireInboundTurnLease();
  if (lease.inboundTurn.id !== context.runId || lease.inboundTurn.messageId !== context.requestId) throw new Error('DOMAIN_TURN_MISMATCH');
  lease.signal.throwIfAborted();
  await lease.assertActive();
  context.signal.throwIfAborted(); lease.signal.throwIfAborted();
  return { user: { ...user, timezone: context.timezone, locale: context.language === 'en' ? 'en-US' : 'es-CO' },
    language: context.language, referenceTime: new Date(context.referenceTimeIso), correlationId: context.requestId,
    isPro: context.capabilities.has('reminders.pro') };
}

/** Shared domain envelope; no generic tool routing or inference retry. */
export function domainResult(value: unknown): unknown {
  const result = z.looseObject({ success: z.boolean(), action: z.string().optional(), error: z.string().optional(),
    confirmation: z.string().nullish(), formattedCard: z.string().nullish(), rawSummary: z.string().nullish(),
    requiresClarification: z.boolean().optional() }).parse(value);
  if (result.outcome === 'unknown') return { ...result, success: false, complete: false, partialSuccess: false };
  return { ...result, action: result.action ?? 'error',
    confirmation: result.confirmation ?? result.formattedCard ?? result.rawSummary
      ?? (result.requiresClarification ? result.error : undefined) };
}

/** Only used by legacy callers/tests while those entry points are retired. */
export function compatibilityParameters(value: unknown) {
  return jsonObjectSchema.parse(JSON.parse(JSON.stringify(value)));
}
