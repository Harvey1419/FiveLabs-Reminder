import { jsonObjectSchema, suspendedRunSnapshotSchema, type JsonObject, type SuspendedRunSnapshot } from '@templelabs/contracts';
export interface ActiveRunClaim { readonly claimId: string; readonly snapshot: SuspendedRunSnapshot; readonly status: 'running' | 'cancelled' }
export interface ActiveRunStore {
  claim(snapshot: SuspendedRunSnapshot, nextStatus: 'running' | 'cancelled', decision: JsonObject): Promise<ActiveRunClaim | null>;
  mutate(claim: ActiveRunClaim, operation: 'assert' | 'action' | 'run' | 'event' | 'finish', payload: JsonObject): Promise<JsonObject>;
}
export interface ActiveRunRpcClient { rpc(name: string, args: JsonObject): PromiseLike<{ readonly data: unknown; readonly error: unknown }> }
/** Credentials/lease token belong to backend construction, never to the model's decision. No offline fallback. */
export function createActiveRunStore(client: ActiveRunRpcClient, owner: { readonly id: string; readonly token: string }): ActiveRunStore {
  const id = owner.id, token = owner.token;
  const invoke = async (name: string, args: JsonObject) => {
    const { data, error } = await client.rpc(name, { ...args, p_owner_id: id, p_owner_token: token });
    if (error) throw Object.assign(new Error('ACTIVE_RUN_STORAGE_ERROR'), { code: 'ACTIVE_RUN_STORAGE_ERROR' });
    return data;
  };
  return {
    async claim(snapshot, nextStatus, decision) {
      const raw = await invoke('claim_hermes_active_run', { p_expected: jsonObjectSchema.parse(snapshot), p_next_status: nextStatus, p_decision: decision });
      if (raw === null) return null;
      const value = jsonObjectSchema.parse(raw);
      if (typeof value.claimId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.claimId) || !['running','cancelled'].includes(String(value.status))) throw new Error('INVALID_ACTIVE_RUN_CLAIM');
      return { claimId: value.claimId, snapshot: suspendedRunSnapshotSchema.parse(value.snapshot), status: value.status as 'running' | 'cancelled' };
    },
    async mutate(claim, operation, payload) {
      const raw = await invoke('mutate_hermes_active_run', { p_run_id: claim.snapshot.runId, p_claim_id: claim.claimId, p_operation: operation, p_payload: payload });
      if (raw === null) throw Object.assign(new Error('ACTIVE_RUN_WRITE_CONFLICT'), { code: 'ACTIVE_RUN_WRITE_CONFLICT' });
      return jsonObjectSchema.parse(raw);
    },
  };
}
