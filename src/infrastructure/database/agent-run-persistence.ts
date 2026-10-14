import { isDeepStrictEqual } from 'node:util';
import type { JsonObject } from '@templelabs/contracts';
import type { LegacyReferenceTime, LegacyRunUser } from '../../agent/core/active-run-lifecycle.js';

export interface AgentRunRow { id: string; user_id: string | null; thread_id: string; status: string; kind: string;
  waiting_for: JsonObject | null; context: JsonObject | null; expires_at: string; created_at?: string; updated_at?: string; }
export interface PreparedActionRow { id: string; run_id: string; call_id: string; domain: string; action: string;
  target_id: string | null; target_name: string | null; payload: JsonObject; status: 'prepared' | 'executed' | 'skipped' | 'failed';
  execution_fact: JsonObject | null; created_at: string; executed_at?: string | null; }
export interface ExecutionEventRow { id: string; run_id: string | null; user_id: string | null; thread_id: string;
  event_type: string; fact_payload: JsonObject; created_at: string; }
export interface CreateAgentRunInput { userId: string | null; threadId?: string | null; kind: string;
  waitingFor?: JsonObject | null; context?: JsonObject | null; expiresAt: LegacyReferenceTime; initialStatus?: 'failed' | null; }
export interface AgentRunUpdate { status?: string; waitingFor?: JsonObject | null; context?: JsonObject | null; now?: LegacyReferenceTime; }
export interface ConditionalStatusInput { runId: string; userId?: string | null; threadId?: string | null;
  expectedStatus: string; nextStatus: string; now?: LegacyReferenceTime; }
export type CancelInputRunInput = Omit<ConditionalStatusInput,'expectedStatus' | 'nextStatus'> & { expectedStatus?: string };
export interface PreparedActionInput { callId?: string; domain: string; action: string; targetId?: string | null;
  targetName?: string | null; payload?: JsonObject; status?: PreparedActionRow['status']; executionFact?: JsonObject | null; }
export interface PreparedActionUpdate { status?: PreparedActionRow['status']; executionFact?: JsonObject | null;
  payload?: JsonObject; now?: LegacyReferenceTime; }
export interface ExecutionEventInput { runId?: string | null; userId: string | null; threadId?: string | null;
  eventType: string; factPayload?: JsonObject; }
interface QueryResult<T> { readonly data: T | null; readonly error: unknown }
/** Narrow service-side SDK boundary. No SDK import, credentials or configuration in this module. */
export interface AgentPersistenceQuery<T> extends PromiseLike<QueryResult<T[]>> {
  insert(payload: unknown): AgentPersistenceQuery<T>;
  update(payload: unknown): AgentPersistenceQuery<T>;
  upsert(payload: unknown, options: { onConflict: string }): AgentPersistenceQuery<T>;
  select(columns?: string): AgentPersistenceQuery<T>;
  eq(column: string, value: unknown): AgentPersistenceQuery<T>;
  in(column: string, values: readonly string[]): AgentPersistenceQuery<T>;
  gt(column: string, value: string): AgentPersistenceQuery<T>;
  order(column: string, options: { ascending: boolean }): AgentPersistenceQuery<T>;
  single(): PromiseLike<QueryResult<T>>;
  maybeSingle(): PromiseLike<QueryResult<T>>;
}
interface PersistenceRows { agent_runs: AgentRunRow; prepared_actions: PreparedActionRow; agent_execution_events: ExecutionEventRow }
export interface AgentRunPersistenceClient { from<K extends keyof PersistenceRows>(table: K): AgentPersistenceQuery<PersistenceRows[K]> }
function isStorageError(error: unknown): boolean { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'AGENT_RUN_STORAGE_ERROR'; }

/** Per-store offline state is used only when the host explicitly reports unconfigured persistence. */
export function createAgentRunPersistence(getClient: () => AgentRunPersistenceClient, isDatabaseConfigured: () => boolean) {
  const inMemoryRuns = new Map<string, AgentRunRow>();
  const inMemoryPrepared = new Map<string, PreparedActionRow[]>();
  const inMemoryEvents: ExecutionEventRow[] = [];
  const SUPPORTED_RUN_KINDS = new Set([
    'reminder_creation',
    'entity_destructive_batch',
    'task_mutation',
    'generic_operation',
  ]);
  const LEGACY_RUN_KINDS = new Set(['input_draft', 'proposal_approval']);

  function normalizeRunKind(kind: string) {
    if (LEGACY_RUN_KINDS.has(kind)) return 'generic_operation';
    if (SUPPORTED_RUN_KINDS.has(kind)) return kind;
    throw new Error(`Unsupported agent run kind: ${String(kind)}`);
  }

  function storageError(operation: string, error: unknown) {
    const detail = error instanceof Error ? error.message : error && typeof error === 'object' && 'message' in error ? String(error.message) : undefined;
    const wrapped = Object.assign(new Error(`Could not persist ${operation}${detail ? `: ${detail}` : ''}`), { code: 'AGENT_RUN_STORAGE_ERROR' });
    return wrapped;
  }

  function resetInMemoryAgentRuns() {
    inMemoryRuns.clear();
    inMemoryPrepared.clear();
    inMemoryEvents.length = 0;
  }

  function clearAgentRunsForUser(userOrPhone: LegacyRunUser) {
    if (!userOrPhone) {
      resetInMemoryAgentRuns();
      return;
    }
    const keys = new Set();
    if (typeof userOrPhone === 'string') {
      keys.add(userOrPhone.trim());
    } else if (typeof userOrPhone === 'object') {
      if (userOrPhone.id) keys.add(String(userOrPhone.id).trim());
      if (userOrPhone.phone_number) keys.add(String(userOrPhone.phone_number).trim());
    }

    for (const [id, run] of Array.from(inMemoryRuns.entries())) {
      if (keys.has(run.user_id) || keys.has(run.thread_id)) {
        inMemoryRuns.delete(id);
        inMemoryPrepared.delete(id);
      }
    }
  }

  /**
   * Create a new AgentRun in durable storage.
   */
  async function createAgentRunInDb({
    userId,
    threadId,
    kind,
    waitingFor = null,
    context = {},
    expiresAt,
    initialStatus = null,
  }: CreateAgentRunInput) {
    const persistedKind = normalizeRunKind(kind);
    if (initialStatus != null && initialStatus !== 'failed') {
      throw new Error(`Unsupported initial AgentRun status: ${String(initialStatus)}`);
    }
    const payload = {
      user_id: userId,
      thread_id: String(threadId || userId),
      status: initialStatus || (waitingFor ? (waitingFor.type === 'missing_fields' ? 'waiting_for_input' : 'waiting_for_approval') : 'running'),
      kind: persistedKind,
      waiting_for: waitingFor,
      context: context || {},
      expires_at: typeof expiresAt === 'string' ? expiresAt : new Date(expiresAt).toISOString(),
    };

    if (isDatabaseConfigured()) {
      try {
        const { data, error } = await getClient()
          .from('agent_runs')
          .insert(payload)
          .select()
          .single();

        if (error || !data) throw storageError('AgentRun', error);
        inMemoryRuns.set(data.id, data);
        return data;
      } catch (err) {
        throw isStorageError(err) ? err : storageError('AgentRun', err);
      }
    }

    const fallbackRun = {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ...payload,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    inMemoryRuns.set(fallbackRun.id, fallbackRun);
    return fallbackRun;
  }

  /**
   * Retrieve the active AgentRun for a given user or thread.
   * If the run has passed expires_at, it is marked 'expired' and null is returned.
   */
  async function getActiveRunFromDb(threadId: string | null, userId: string | null = null, now: LegacyReferenceTime = new Date()) {
    const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const threadStr = String(threadId || userId);

    if (isDatabaseConfigured()) {
      try {
        let query = getClient()
          .from('agent_runs')
          .select('*')
          .in('status', ['waiting_for_input', 'waiting_for_approval', 'running'])
          .order('created_at', { ascending: false });

        if (userId) {
          query = query.eq('user_id', userId);
        } else {
          query = query.eq('thread_id', threadStr);
        }

        const { data, error } = await query;
        if (error || !Array.isArray(data)) throw storageError('active AgentRun lookup', error);
        if (data.length > 0) {
          const active = data[0]!;
          if (new Date(active.expires_at) <= new Date(nowIso)) {
            await updateAgentRunInDb(active.id, { status: 'expired' });
            return null;
          }
          return active;
        }
        return null;
      } catch (err) {
        throw isStorageError(err) ? err : storageError('active AgentRun lookup', err);
      }
    }

    // Fallback search in memory
    for (const run of Array.from(inMemoryRuns.values()).reverse()) {
      const matchesUser = userId ? run.user_id === userId : run.thread_id === threadStr;
      if (matchesUser && ['waiting_for_input', 'waiting_for_approval', 'running'].includes(run.status)) {
        if (new Date(run.expires_at) <= new Date(nowIso)) {
          run.status = 'expired';
          run.updated_at = nowIso;
          return null;
        }
        return run;
      }
    }

    return null;
  }

  /**
   * Update AgentRun status and optional context/waitingFor.
   */
  async function updateAgentRunInDb(runId: string, {
    status,
    waitingFor = undefined,
    context = undefined,
    now = new Date(),
  }: AgentRunUpdate = {}) {
    const updates: { updated_at: string; status?: string; waiting_for?: JsonObject | null; context?: JsonObject | null } = {
      updated_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    };
    if (status) updates.status = status;
    if (waitingFor !== undefined) updates.waiting_for = waitingFor;
    if (context !== undefined) updates.context = context;

    if (isDatabaseConfigured()) {
      try {
        const { data, error } = await getClient()
          .from('agent_runs')
          .update(updates)
          .eq('id', runId)
          .select()
          .single();

        if (error || !data) throw storageError('AgentRun update', error);
        inMemoryRuns.set(runId, data);
        return data;
      } catch (err) {
        throw isStorageError(err) ? err : storageError('AgentRun update', err);
      }
    }

    const existing = inMemoryRuns.get(runId);
    if (existing) {
      const updated = { ...existing, ...updates };
      inMemoryRuns.set(runId, updated);
      return updated;
    }
    return null;
  }

  /**
   * Atomically change a run status only while its owner and expected status match.
   */
  async function updateAgentRunIfStatusFromDb({
    runId,
    userId = null,
    threadId = null,
    expectedStatus,
    nextStatus,
    now = new Date(),
  }: ConditionalStatusInput) {
    if (!runId || !expectedStatus || !nextStatus || (!userId && !threadId)) return false;
    const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const updates = { status: nextStatus, updated_at: nowIso };

    if (isDatabaseConfigured()) {
      try {
        let query = getClient()
          .from('agent_runs')
          .update(updates)
          .eq('id', runId)
          .eq('status', expectedStatus)
          .gt('expires_at', nowIso);
        query = userId ? query.eq('user_id', userId) : query.eq('thread_id', threadId);
        const { data, error } = await query.select().maybeSingle();
        if (error) throw storageError('conditional AgentRun status update', error);
        if (!data || data.id !== runId || data.status !== nextStatus) return false;
        const cached = inMemoryRuns.get(runId);
        if (cached) inMemoryRuns.set(runId, { ...cached, ...updates });
        return true;
      } catch (err) {
        throw isStorageError(err)
          ? err
          : storageError('conditional AgentRun status update', err);
      }
    }

    const existing = inMemoryRuns.get(runId);
    const ownerMatches = userId
      ? existing?.user_id === userId
      : existing?.thread_id === String(threadId);
    if (
      !existing
      || !ownerMatches
      || existing.status !== expectedStatus
      || new Date(existing.expires_at) <= new Date(nowIso)
    ) return false;

    inMemoryRuns.set(runId, { ...existing, ...updates });
    return true;
  }

  /** Atomically cancel a non-expired pending input run owned by the caller. */
  async function cancelActiveInputRunFromDb({ runId, userId = null, threadId = null, now = new Date(), expectedStatus = 'waiting_for_input' }: CancelInputRunInput) {
    return updateAgentRunIfStatusFromDb({
      runId,
      userId,
      threadId,
      expectedStatus,
      nextStatus: 'cancelled',
      now,
    });
  }

  /**
   * Stage prepared actions for a specific run.
   */
  async function stagePreparedActionsInDb(runId: string, preparedActions: readonly PreparedActionInput[] = []) {
    if (!runId) {
      return [];
    }
    if (!Array.isArray(preparedActions) || preparedActions.length === 0) {
      throw storageError('prepared actions', new Error('No prepared actions were provided'));
    }

    const rows: Omit<PreparedActionRow, 'id'>[] = preparedActions.map((action, index) => ({
      run_id: runId,
      call_id: action.callId || `call-${index + 1}`,
      domain: action.domain,
      action: action.action,
      target_id: action.targetId || null,
      target_name: action.targetName || null,
      payload: action.payload || {},
      status: action.status || 'prepared',
      execution_fact: action.executionFact || null,
      created_at: new Date().toISOString(),
    }));
    const expectedByCallId = new Map(rows.map((row) => [row.call_id, row]));
    if (expectedByCallId.size !== rows.length) {
      throw storageError('prepared actions', new Error('Prepared action call IDs must be unique'));
    }

    const validateStagedRows = (data: PreparedActionRow[] | null): data is PreparedActionRow[] => {
      if (!Array.isArray(data) || data.length !== rows.length) return false;
      const seenCallIds = new Set<string>();
      return data.every((row) => {
        const expected = expectedByCallId.get(row.call_id);
        if (!row.id || row.run_id !== runId || !expected || seenCallIds.has(row.call_id)) return false;
        seenCallIds.add(row.call_id);
        return row.domain === expected.domain
          && row.action === expected.action
          && row.target_id === expected.target_id
          && row.target_name === expected.target_name
          && row.status === expected.status
          && isDeepStrictEqual(row.payload, expected.payload);
      });
    };

    if (isDatabaseConfigured()) {
      try {
        const { data, error } = await getClient()
          .from('prepared_actions')
          .upsert(rows, { onConflict: 'run_id,call_id' })
          .select();

        if (error || !validateStagedRows(data)) {
          throw storageError('complete prepared actions', error || new Error('Storage returned incomplete or mismatched rows'));
        }
        inMemoryPrepared.set(runId, data);
        return data;
      } catch (err) {
        throw isStorageError(err) ? err : storageError('prepared actions', err);
      }
    }

    const cached = inMemoryPrepared.get(runId) || [];
    const byCallId = new Map(cached.map((c) => [c.call_id, c]));
    for (const r of rows) {
      const existing = byCallId.get(r.call_id);
      if (existing) {
        Object.assign(existing, r);
      } else {
        byCallId.set(r.call_id, {
          id: `prep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          ...r,
        });
      }
    }
    const resultRows = Array.from(byCallId.values());
    inMemoryPrepared.set(runId, resultRows);
    return resultRows;
  }

  /**
   * Get all prepared actions for a run.
   */
  async function getPreparedActionsFromDb(runId: string) {
    if (!runId) return [];

    if (isDatabaseConfigured()) {
      try {
        const { data, error } = await getClient()
          .from('prepared_actions')
          .select('*')
          .eq('run_id', runId)
          .order('call_id', { ascending: true });

        if (error || !Array.isArray(data)) throw storageError('prepared actions lookup', error);
        return data;
      } catch (err) {
        throw isStorageError(err) ? err : storageError('prepared actions lookup', err);
      }
    }

    return inMemoryPrepared.get(runId) || [];
  }

  /**
   * Update the execution status of a prepared action.
   */
  async function updatePreparedActionInDb(runId: string, callId: string, {
    status,
    executionFact = null,
    payload = undefined,
    now = new Date(),
  }: PreparedActionUpdate = {}) {
    const updates = {
      status,
      execution_fact: executionFact,
      executed_at: status === 'executed' ? (now instanceof Date ? now.toISOString() : new Date(now).toISOString()) : null,
      ...(payload !== undefined ? { payload } : {}),
    };

    if (isDatabaseConfigured()) {
      try {
        const { data, error } = await getClient()
          .from('prepared_actions')
          .update(updates)
          .eq('run_id', runId)
          .eq('call_id', callId)
          .select()
          .single();

        if (error || !data) throw storageError('prepared action update', error);
        const cached = inMemoryPrepared.get(runId) || [];
        const idx = cached.findIndex((a) => a.call_id === callId);
        if (idx >= 0) cached[idx] = data;
        return data;
      } catch (err) {
        throw isStorageError(err) ? err : storageError('prepared action update', err);
      }
    }

    const cached = inMemoryPrepared.get(runId) || [];
    const item = cached.find((a) => a.call_id === callId);
    if (item) {
      Object.assign(item, updates);
      return item;
    }
    return null;
  }

  /**
   * Record an execution event (audit fact log).
   */
  async function recordExecutionEventInDb({
    runId = null,
    userId,
    threadId,
    eventType,
    factPayload = {},
  }: ExecutionEventInput) {
    const event = {
      run_id: runId,
      user_id: userId,
      thread_id: String(threadId || userId),
      event_type: eventType,
      fact_payload: factPayload,
      created_at: new Date().toISOString(),
    };

    if (isDatabaseConfigured()) {
      try {
        const { data, error } = await getClient()
          .from('agent_execution_events')
          .insert(event)
          .select()
          .single();

        if (error || !data) throw storageError('execution event', error);
        return data;
      } catch (err) {
        throw isStorageError(err) ? err : storageError('execution event', err);
      }
    }

    const fallback = { id: `evt-${Date.now()}`, ...event };
    inMemoryEvents.push(fallback);
    return fallback;
  }
  return { resetInMemoryAgentRuns, clearAgentRunsForUser, createAgentRunInDb, getActiveRunFromDb, updateAgentRunInDb, updateAgentRunIfStatusFromDb, cancelActiveInputRunFromDb, stagePreparedActionsInDb, getPreparedActionsFromDb, updatePreparedActionInDb, recordExecutionEventInDb };
}
