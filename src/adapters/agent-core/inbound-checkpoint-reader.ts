import { z } from 'zod';
import { jsonObjectSchema, type TurnContext } from '@templelabs/contracts';
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
export const inboundStoredTurnSchema = identitySchema.extend({ response: jsonObjectSchema.nullable() });
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
  const read = async (unknownOnly: boolean) => {
    const query = client.from('hermes_inbound_turns').select('id,message_id,thread_id,sequence_id,status,response')
      .eq('thread_id', threadId).lt('sequence_id', anchor.sequence_id);
    const filtered = unknownOnly ? query.eq('status', 'unknown') : query.in('status', ['completed', 'unknown']);
    const result = await filtered.order('sequence_id', { ascending: unknownOnly }).limit(1).abortSignal(signal).maybeSingle();
    if (result.error) throw Object.assign(new Error('Prior checkpoint unavailable'), { code: 'CHECKPOINT_STORAGE_UNAVAILABLE' });
    if (!result.data) return null;
    const row = rowSchema.parse(result.data);
    if (row.thread_id !== threadId || row.sequence_id >= anchor.sequence_id || row.id === anchor.id
      || row.status === 'running' || (unknownOnly && row.status !== 'unknown')) throw new Error('Invalid prior turn identity/order');
    return row;
  };
  // Search ALL prior unknown turns, not just the latest checkpoint or a bounded history page.
  const unknown = await read(true);
  await lease.assertActive();
  signal.throwIfAborted();
  if (unknown) onUnknown(unknown);
  const previous = await read(false);
  await lease.assertActive();
  signal.throwIfAborted();
  return previous;

}
