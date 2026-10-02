import { supabase } from './index.js';

async function observed(query) {
  const { data, error } = await query.abortSignal(AbortSignal.timeout(15000));
  if (error) throw Object.assign(new Error('Inbound turn persistence unavailable.'), { code: 'INBOUND_STORAGE_UNAVAILABLE', cause: error });
  return data;
}

export async function enqueueInboundTurn({ messageId, threadId, request }) {
  if (!messageId || !threadId) throw new Error('A durable turn requires a message and recipient identity.');
  const rows = await observed(supabase.from('hermes_inbound_turns')
    .upsert({ message_id: messageId, thread_id: threadId, request }, { onConflict: 'message_id', ignoreDuplicates: true })
    .select('id'));
  return { inserted: Boolean(rows?.length) };
}

export const inboundTurnStorage = {
  async claim(threadId = null) {
    const rows = await observed(supabase.rpc('claim_hermes_inbound_turn', { p_thread_id: threadId }));
    return rows?.[0] || null;
  },
  renew: turn => observed(supabase.rpc('renew_hermes_inbound_turn', { p_id: turn.id, p_token: turn.lease_token })),
  checkpoint: (turn, response) => observed(supabase.rpc('checkpoint_hermes_inbound_turn', { p_id: turn.id, p_token: turn.lease_token, p_response: response })),
  finish: (turn, status, error = null) => observed(supabase.rpc('finish_hermes_inbound_turn', { p_id: turn.id, p_token: turn.lease_token, p_status: status, p_error: error })),
};

export async function assertInboundQueueReady() {
  // Pure lookup: verifies the additive migration and service-role table access.
  await observed(supabase.from('hermes_inbound_turns').select('id').limit(0));
  const version = await observed(supabase.rpc('hermes_inbound_queue_version'));
  if (version !== 1) throw new Error('Unsupported inbound queue schema; migration required.');
}
