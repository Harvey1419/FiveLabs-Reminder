import { z } from 'zod';
import { jsonObjectSchema, type TurnContext } from '@templelabs/contracts';
import { admissionRejectionSchema } from '../../agent/core/admission-rejection.js';
import { requireInboundTurnLease } from '../../agent/core/turn-lease.js';

interface QueueReadQuery {
  eq(column: string, value: string): QueueReadQuery;
  lt(column: string, value: number): QueueReadQuery;
  in(column: string, values: string[]): QueueReadQuery;
  order(column: string, options: { ascending: boolean }): QueueReadQuery;
  limit(count: number): QueueReadQuery;
  abortSignal(signal: AbortSignal): QueueReadQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}
/** Narrow structural SDK boundary avoids coupling the core to authentication/browser types. */
export interface InboundCheckpointClient {
  from(table: string): { select(columns: string): QueueReadQuery };
}
const identitySchema = z.object({ id: z.string().min(1), message_id: z.string().min(1), thread_id: z.string().min(1),
  sequence_id: z.number().int().positive().refine(Number.isSafeInteger), status: z.enum(['running', 'completed', 'unknown']) });
export const inboundStoredTurnSchema = identitySchema.extend({ response: jsonObjectSchema.nullable(), last_error: z.string().nullish() });
const rowSchema = inboundStoredTurnSchema;
export type InboundStoredTurn = z.infer<typeof rowSchema>;

/** Fenced queue reader shared by checkpoint versions. All older unknown turns block continuity. */
export async function readPriorInboundTurn(client: InboundCheckpointClient, context: TurnContext,
  threadId: string, onUnknown: (turn: InboundStoredTurn) => never): Promise<InboundStoredTurn | null> {
  const lease = requireInboundTurnLease();
  const turn = lease.inboundTurn;
  if (context.runId !== turn.id || context.requestId !== turn.messageId || threadId !== turn.threadId) {
    throw Object.assign(new Error('Inbound identity mismatch'), { code: 'INBOUND_IDENTITY_MISMATCH' });
  }
  const signal = AbortSignal.any([context.signal, lease.signal, AbortSignal.timeout(15000)]);
  signal.throwIfAborted();
  await lease.assertActive();
  const anchorResult = await client.from('hermes_inbound_turns')
    .select('id,message_id,thread_id,sequence_id,status').eq('id', context.runId)
    .eq('message_id', context.requestId).eq('thread_id', threadId).eq('status', 'running')
    .limit(1).abortSignal(signal).maybeSingle();
  if (anchorResult.error || !anchorResult.data) throw Object.assign(new Error('Current turn unavailable'), { code: 'CHECKPOINT_STORAGE_UNAVAILABLE' });
  const anchor = identitySchema.parse(anchorResult.data);
  if (anchor.id !== turn.id || anchor.message_id !== turn.messageId || anchor.thread_id !== threadId || anchor.status !== 'running') {
    throw new Error('Invalid current turn identity');
  }
  const read = async (unknownOnly: boolean, before = anchor.sequence_id) => {
    const query = client.from('hermes_inbound_turns').select('id,message_id,thread_id,sequence_id,status,response,last_error')
      .eq('thread_id', threadId).lt('sequence_id', before);
    const filtered = unknownOnly ? query.eq('status', 'unknown') : query.in('status', ['completed', 'unknown']);
    const result = await filtered.order('sequence_id', { ascending: false }).limit(1).abortSignal(signal).maybeSingle();
    if (result.error) throw Object.assign(new Error('Prior checkpoint unavailable'), { code: 'CHECKPOINT_STORAGE_UNAVAILABLE' });
    if (!result.data) return null;
    const row = rowSchema.parse(result.data);
    if (row.thread_id !== threadId || row.sequence_id >= anchor.sequence_id || row.id === anchor.id
      || row.status === 'running' || (unknownOnly && row.status !== 'unknown')) throw new Error('Invalid prior turn identity/order');
    return row;
  };
  const safeRejection = (row: InboundStoredTurn): boolean => {
    const response = row.response;
    // The old router emitted this particular gate error only BEFORE invoking either engine.
    // A started V2 run always checkpoints its namespace before any domain dispatch or delivery.
    // Never generalize this to empty-response timeouts, lease expiry, or arbitrary unknown errors.
    if (row.status === 'unknown' && row.last_error === 'PRIOR_TURN_RECONCILIATION_REQUIRED'
      && (response === null || Object.keys(response).length === 0)) return true;
    if (!response || Object.keys(response).length !== 1) return false;
    const parsed = admissionRejectionSchema.safeParse(response.agentCoreAdmissionRejected);
    return parsed.success && parsed.data.runId === row.id && parsed.data.requestId === row.message_id
      && parsed.data.threadId === threadId && parsed.data.userId === context.userId;
  };
  // Search ALL older unknown turns, skipping only certified non-dispatch admission failures.
  // Retain the original rows; no resetting status, requeueing, replaying or fabricating a conversation.
  let before = anchor.sequence_id;
  for (let count = 0; count < 100; count++) {
    const unknown = await read(true, before);
    await lease.assertActive(); signal.throwIfAborted();
    if (!unknown) break;
    if (unknown.sequence_id >= before) throw new Error('Invalid prior cursor');
    if (!safeRejection(unknown)) onUnknown(unknown);
    before = unknown.sequence_id;
    if (count === 99) throw new Error('Admission rejection inspection limit reached');
  }
  before = anchor.sequence_id;
  for (let count = 0; count < 100; count++) {
    const previous = await read(false, before);
    await lease.assertActive(); signal.throwIfAborted();
    if (!previous) return null;
    if (previous.sequence_id >= before) throw new Error('Invalid prior cursor');
    if (!safeRejection(previous)) return previous;
    before = previous.sequence_id;
  }
  throw new Error('Admission rejection inspection limit reached');
}
