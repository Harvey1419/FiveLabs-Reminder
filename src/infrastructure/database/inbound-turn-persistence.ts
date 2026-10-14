import { z } from 'zod';
import type { JsonObject } from '@templelabs/contracts';
import type { ClaimedInboundTurn, InboundTurnWorkerStorage } from '../../jobs/inbound-turn-worker.js';

interface PersistenceResult { readonly data: unknown; readonly error: unknown }
export interface InboundPersistenceQuery extends PromiseLike<PersistenceResult> {
  abortSignal(signal: AbortSignal): PromiseLike<PersistenceResult>;
  upsert(payload: JsonObject, options: { onConflict: string; ignoreDuplicates: boolean }): InboundPersistenceQuery;
  select(columns: string): InboundPersistenceQuery;
  limit(count: number): InboundPersistenceQuery;
}
export interface InboundTurnPersistenceClient {
  from(table: 'hermes_inbound_turns'): InboundPersistenceQuery;
  rpc(name: string, args?: JsonObject): InboundPersistenceQuery;
}
const jsonObjectSchema = z.record(z.string(),z.json());
const claimedTurnSchema = z.object({ id: z.string().min(1), message_id: z.string().min(1), thread_id: z.string().min(1),
  lease_token: z.string().min(1), request: jsonObjectSchema, response: jsonObjectSchema.nullable().default(null) }).passthrough();
function unavailable(cause: unknown): never {
  throw Object.assign(new Error('Inbound turn persistence unavailable.'), { code: 'INBOUND_STORAGE_UNAVAILABLE', cause });
}
/** Typed, bounded queue adapter. The host owns the client and its ambient lease-aware transport. */
export function createInboundTurnPersistence(getClient: () => InboundTurnPersistenceClient) {
  async function observed(query: InboundPersistenceQuery): Promise<unknown> {
    const { data, error } = await query.abortSignal(AbortSignal.timeout(15000));
    if (error) unavailable(error);
    return data;
  }
  async function acknowledged(query: InboundPersistenceQuery): Promise<boolean> {
    const value = await observed(query);
    if (typeof value !== 'boolean') unavailable(new Error('Invalid queue acknowledgement.'));
    return value;
  }
  async function enqueueInboundTurn({ messageId, threadId, request }: { messageId: string; threadId: string; request: JsonObject }) {
    if (!messageId || !threadId) throw new Error('A durable turn requires a message and recipient identity.');
    const data = await observed(getClient().from('hermes_inbound_turns')
      .upsert({ message_id: messageId, thread_id: threadId, request },{ onConflict: 'message_id', ignoreDuplicates: true }).select('id'));
    const rows = z.array(z.object({ id: z.string().min(1) })).max(1).safeParse(data);
    if (!rows.success) unavailable(rows.error);
    return { inserted: rows.data.length > 0 };
  }
  const inboundTurnStorage: Omit<InboundTurnWorkerStorage,'claim' | 'finish'> & { claim(threadId?: string | null): Promise<ClaimedInboundTurn | null>; finish(turn: ClaimedInboundTurn,status: 'completed' | 'unknown',error?: string | null): Promise<boolean> } = {
    async claim(threadId: string | null = null) {
      const data = await observed(getClient().rpc('claim_hermes_inbound_turn',{ p_thread_id: threadId }));
      const rows = z.array(claimedTurnSchema).max(1).safeParse(data);
      if (!rows.success) unavailable(rows.error);
      return rows.data[0] ?? null;
    },
    renew: turn => acknowledged(getClient().rpc('renew_hermes_inbound_turn',{ p_id: turn.id,p_token: turn.lease_token })),
    checkpoint: (turn,response) => acknowledged(getClient().rpc('checkpoint_hermes_inbound_turn',{ p_id: turn.id,p_token: turn.lease_token,p_response: response })),
    resolvePrior: (turn,runId,expectedResponse,resolution) => acknowledged(getClient().rpc('resolve_hermes_prior_turn',{
      p_owner_id: turn.id,p_owner_token: turn.lease_token,p_target_id: runId,p_expected_response: expectedResponse,p_resolution: resolution,
    })),
    observeFinalization: turn => acknowledged(getClient().rpc('was_completed_hermes_active_turn',{ p_id: turn.id,p_token: turn.lease_token })),
    finish: (turn,status,error = null) => acknowledged(getClient().rpc('finish_hermes_inbound_turn',{
      p_id: turn.id,p_token: turn.lease_token,p_status: status,p_error: error,
    })),
  };
  async function assertInboundQueueReady() {
    await observed(getClient().from('hermes_inbound_turns').select('id').limit(0));
    const version = await observed(getClient().rpc('hermes_inbound_queue_version'));
    if (version !== 1) throw new Error('Unsupported inbound queue schema; migration required.');
  }
  return { enqueueInboundTurn,inboundTurnStorage,assertInboundQueueReady };
}
