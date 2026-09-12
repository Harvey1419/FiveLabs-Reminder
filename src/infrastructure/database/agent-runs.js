import { supabase } from './index.js';

/**
 * In-memory fallback store for offline unit tests and resilience
 * when Supabase client is mocked or unavailable.
 */
const inMemoryRuns = new Map();
const inMemoryPrepared = new Map();
const inMemoryEvents = [];

export function resetInMemoryAgentRuns() {
  inMemoryRuns.clear();
  inMemoryPrepared.clear();
  inMemoryEvents.length = 0;
}

export function clearAgentRunsForUser(userOrPhone) {
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

function isDatabaseConfigured() {
  const url = process.env.SUPABASE_URL || '';
  const secret = process.env.SUPABASE_SECRET || '';
  return Boolean(
    url
    && !url.includes('placeholder')
    && secret
    && !secret.includes('placeholder')
    && typeof supabase?.from === 'function'
  );
}

/**
 * Create a new AgentRun in durable storage.
 */
export async function createAgentRunInDb({
  userId,
  threadId,
  kind,
  waitingFor = null,
  context = {},
  expiresAt,
}) {
  const payload = {
    user_id: userId,
    thread_id: String(threadId || userId),
    status: waitingFor ? (waitingFor.type === 'missing_fields' ? 'waiting_for_input' : 'waiting_for_approval') : 'running',
    kind,
    waiting_for: waitingFor,
    context: context || {},
    expires_at: typeof expiresAt === 'string' ? expiresAt : new Date(expiresAt).toISOString(),
  };

  if (isDatabaseConfigured()) {
    try {
      const { data, error } = await supabase
        .from('agent_runs')
        .insert(payload)
        .select()
        .single();

      if (!error && data) {
        inMemoryRuns.set(data.id, data);
        return data;
      }
    } catch (_err) {
      // Fallback to in-memory store
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
export async function getActiveRunFromDb(threadId, userId = null, now = new Date()) {
  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const threadStr = String(threadId || userId);

  if (isDatabaseConfigured()) {
    try {
      let query = supabase
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
      if (!error && Array.isArray(data) && data.length > 0) {
        const active = data[0];
        if (new Date(active.expires_at) <= new Date(nowIso)) {
          await updateAgentRunInDb(active.id, { status: 'expired' });
          return null;
        }
        return active;
      }
    } catch (_err) {
      // Fallback to in-memory store
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
export async function updateAgentRunInDb(runId, {
  status,
  waitingFor = undefined,
  context = undefined,
  now = new Date(),
} = {}) {
  const updates = {
    updated_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
  };
  if (status) updates.status = status;
  if (waitingFor !== undefined) updates.waiting_for = waitingFor;
  if (context !== undefined) updates.context = context;

  if (isDatabaseConfigured()) {
    try {
      const { data, error } = await supabase
        .from('agent_runs')
        .update(updates)
        .eq('id', runId)
        .select()
        .single();

      if (!error && data) {
        inMemoryRuns.set(runId, data);
        return data;
      }
    } catch (_err) {
      // Fallback to memory
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
 * Stage prepared actions for a specific run.
 */
export async function stagePreparedActionsInDb(runId, preparedActions = []) {
  if (!runId || !Array.isArray(preparedActions) || preparedActions.length === 0) {
    return [];
  }

  const rows = preparedActions.map((action, index) => ({
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

  if (isDatabaseConfigured()) {
    try {
      const { data, error } = await supabase
        .from('prepared_actions')
        .upsert(rows, { onConflict: 'run_id,call_id' })
        .select();

      if (!error && data) {
        inMemoryPrepared.set(runId, data);
        return data;
      }
    } catch (_err) {
      // Fallback to memory
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
export async function getPreparedActionsFromDb(runId) {
  if (!runId) return [];

  if (isDatabaseConfigured()) {
    try {
      const { data, error } = await supabase
        .from('prepared_actions')
        .select('*')
        .eq('run_id', runId)
        .order('call_id', { ascending: true });

      if (!error && Array.isArray(data)) {
        return data;
      }
    } catch (_err) {
      // Fallback to memory
    }
  }

  return inMemoryPrepared.get(runId) || [];
}

/**
 * Update the execution status of a prepared action.
 */
export async function updatePreparedActionInDb(runId, callId, {
  status,
  executionFact = null,
  now = new Date(),
} = {}) {
  const updates = {
    status,
    execution_fact: executionFact,
    executed_at: status === 'executed' ? (now instanceof Date ? now.toISOString() : new Date(now).toISOString()) : null,
  };

  if (isDatabaseConfigured()) {
    try {
      const { data, error } = await supabase
        .from('prepared_actions')
        .update(updates)
        .eq('run_id', runId)
        .eq('call_id', callId)
        .select()
        .single();

      if (!error && data) {
        const cached = inMemoryPrepared.get(runId) || [];
        const idx = cached.findIndex((a) => a.call_id === callId);
        if (idx >= 0) cached[idx] = data;
        return data;
      }
    } catch (_err) {
      // Fallback
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
export async function recordExecutionEventInDb({
  runId = null,
  userId,
  threadId,
  eventType,
  factPayload = {},
}) {
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
      const { data, error } = await supabase
        .from('agent_execution_events')
        .insert(event)
        .select()
        .single();

      if (!error && data) return data;
    } catch (_err) {
      // Fallback
    }
  }

  const fallback = { id: `evt-${Date.now()}`, ...event };
  inMemoryEvents.push(fallback);
  return fallback;
}
