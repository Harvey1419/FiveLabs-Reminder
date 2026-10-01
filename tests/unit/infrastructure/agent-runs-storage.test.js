import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { database } = vi.hoisted(() => ({
  database: {
    calls: [],
    failures: [],
    responses: [],
    rows: [],
  },
}));

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: {
    from(table) {
      const state = { table, operation: 'select', payload: null, filters: [] };
      const execute = async () => {
        database.calls.push({ ...state, filters: [...state.filters] });
        const failureIndex = database.failures.findIndex((failure) => (
          failure.table === state.table && failure.operation === state.operation
        ));
        if (failureIndex >= 0) {
          const [{ error }] = database.failures.splice(failureIndex, 1);
          return { data: null, error };
        }
        const responseIndex = database.responses.findIndex((response) => (
          response.table === state.table && response.operation === state.operation
        ));
        if (responseIndex >= 0) {
          const [{ data }] = database.responses.splice(responseIndex, 1);
          return { data, error: null };
        }
        if (state.operation === 'insert' && state.table === 'agent_runs') {
          const row = { id: 'db-run-id', ...state.payload };
          database.rows.push(row);
          return { data: row, error: null };
        }
        if (state.operation === 'upsert') {
          const rows = state.payload.map((row) => ({ id: 'db-prepared-id', ...row }));
          return { data: rows, error: null };
        }
        if (state.operation === 'update' && state.table === 'agent_runs') {
          return { data: { id: 'db-run-id', ...state.payload }, error: null };
        }
        if (state.operation === 'update' && state.table === 'prepared_actions') {
          return { data: { id: 'db-prepared-id', ...state.payload, call_id: 'call-1' }, error: null };
        }
        if (state.operation === 'insert' && state.table === 'agent_execution_events') {
          return { data: { id: 'db-event-id', ...state.payload }, error: null };
        }
        return { data: [], error: null };
      };
      const builder = {
        insert(payload) { state.operation = 'insert'; state.payload = payload; return builder; },
        update(payload) { state.operation = 'update'; state.payload = payload; return builder; },
        upsert(payload) { state.operation = 'upsert'; state.payload = payload; return builder; },
        select() { return builder; },
        single: execute,
        maybeSingle: execute,
        eq(column, value) { state.filters.push([column, value]); return builder; },
        in(column, value) { state.filters.push([column, value]); return builder; },
        order() { return builder; },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
      return builder;
    },
  },
}));

import {
  createAgentRunInDb,
  getActiveRunFromDb,
  getPreparedActionsFromDb,
  recordExecutionEventInDb,
  resetInMemoryAgentRuns,
  stagePreparedActionsInDb,
  updateAgentRunInDb,
  updatePreparedActionInDb,
} from '../../../src/infrastructure/database/agent-runs.js';
import { createApprovalRun, executeApprovalDecision } from '../../../src/agent/core/agent-run.js';
import { executeTool } from '../../../src/agent/tools/index.js';

vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));

const failure = { message: 'simulated durable storage failure', code: 'TEST_STORAGE_FAILURE' };
const user = { id: 'user-test', phone_number: 'phone-test' };

beforeEach(() => {
  database.calls.length = 0;
  database.failures.length = 0;
  database.responses.length = 0;
  database.rows.length = 0;
  resetInMemoryAgentRuns();
  vi.stubEnv('SUPABASE_URL', 'https://unit-test.supabase.co');
  vi.stubEnv('SUPABASE_SECRET', 'unit-test-secret');
  vi.clearAllMocks();
  executeTool.mockResolvedValue({ success: true, complete: true, action: 'executed', data: {} });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AgentRun durable storage boundary', () => {
  it.each(['input_draft', 'proposal_approval'])('normalizes legacy %s kinds without changing staged payload identity', async (kind) => {
    const run = await createAgentRunInDb({
      userId: user.id,
      threadId: user.phone_number,
      kind,
      waitingFor: { type: 'approval', question: 'Confirm?' },
      context: { correlationId: 'corr-1' },
      expiresAt: new Date(Date.now() + 60_000),
    });

    const inserted = database.calls.find((call) => call.table === 'agent_runs' && call.operation === 'insert');
    expect(inserted.payload.kind).toBe('generic_operation');
    expect(run.id).toBe('db-run-id');
    expect(run.context).toEqual({ correlationId: 'corr-1' });

    const staged = await stagePreparedActionsInDb(run.id, [{
      callId: 'call-1', domain: 'reminder', action: 'create', targetId: 'pinned-uuid',
      targetName: 'Dinner', payload: { content: 'Dinner', schedule: { kind: 'local_time', hour: 19 } },
    }]);
    expect(staged[0]).toMatchObject({
      id: 'db-prepared-id', target_id: 'pinned-uuid',
      payload: { content: 'Dinner', schedule: { kind: 'local_time', hour: 19 } },
    });
  });

  it('rejects unsupported kinds instead of mapping them to a generic operation', async () => {
    await expect(createAgentRunInDb({
      userId: user.id, threadId: user.phone_number, kind: 'future_unknown_kind',
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow(/unsupported agent run kind/i);
    expect(database.calls).toHaveLength(0);
  });

  it('surfaces configured create, update, prepared-action, read, and event failures', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const run = await createAgentRunInDb({
      userId: user.id, threadId: user.phone_number, kind: 'generic_operation', expiresAt,
    });
    await stagePreparedActionsInDb(run.id, [{ callId: 'call-1', domain: 'task', action: 'create' }]);
    database.failures.push(
      { table: 'agent_runs', operation: 'insert', error: failure },
      { table: 'agent_runs', operation: 'update', error: failure },
      { table: 'prepared_actions', operation: 'upsert', error: failure },
      { table: 'prepared_actions', operation: 'update', error: failure },
      { table: 'agent_runs', operation: 'select', error: failure },
      { table: 'prepared_actions', operation: 'select', error: failure },
      { table: 'agent_execution_events', operation: 'insert', error: failure },
    );

    await expect(createAgentRunInDb({ userId: user.id, threadId: user.phone_number, kind: 'generic_operation', expiresAt })).rejects.toThrow(/persist AgentRun/i);
    await expect(updateAgentRunInDb('db-run-id', { status: 'cancelled' })).rejects.toThrow(/AgentRun update/i);
    await expect(stagePreparedActionsInDb('db-run-id', [{ callId: 'call-1', domain: 'task', action: 'create' }])).rejects.toThrow(/prepared actions/i);
    await expect(updatePreparedActionInDb(run.id, 'call-1', { status: 'executed' })).rejects.toThrow(/prepared action update/i);
    await expect(getActiveRunFromDb(user.phone_number, user.id)).rejects.toThrow(/active AgentRun lookup/i);
    await expect(getPreparedActionsFromDb(run.id)).rejects.toThrow(/prepared actions lookup/i);
    await expect(recordExecutionEventInDb({ userId: user.id, threadId: user.phone_number, eventType: 'created' })).rejects.toThrow(/execution event/i);
  });

  it('does not execute or report a successful approval when durable staging fails', async () => {
    database.failures.push({ table: 'prepared_actions', operation: 'upsert', error: failure });

    await expect(createApprovalRun({
      user,
      preparedActions: [{ callId: 'call-1', domain: 'entity', action: 'delete', targetId: 'target-1' }],
      question: 'Delete it?',
    })).rejects.toThrow(/prepared actions/i);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('marks a run failed when staging returns only a partial durable action set', async () => {
    database.responses.push({
      table: 'prepared_actions',
      operation: 'upsert',
      data: [{
        id: 'db-prepared-id', run_id: 'db-run-id', call_id: 'call-1', domain: 'entity', action: 'delete',
        target_id: 'target-1', target_name: null, payload: {}, status: 'prepared',
      }],
    });

    await expect(createApprovalRun({
      user,
      preparedActions: [
        { callId: 'call-1', domain: 'entity', action: 'delete', targetId: 'target-1' },
        { callId: 'call-2', domain: 'entity', action: 'delete', targetId: 'target-2' },
      ],
      question: 'Delete both?',
    })).rejects.toThrow(/complete prepared actions/i);

    expect(database.calls.some((call) => (
      call.table === 'agent_runs' && call.operation === 'update' && call.payload.status === 'failed'
    ))).toBe(true);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('does not reconstruct executable actions from preview context when durable rows are absent', async () => {
    const result = await executeApprovalDecision({
      run: {
        id: 'run-without-staged-actions',
        user_id: user.id,
        thread_id: user.phone_number,
        status: 'waiting_for_approval',
        kind: 'entity_destructive_batch',
        context: { previewEntities: [{ id: 'pinned-target', name: 'Project' }] },
        preparedActions: [],
      },
      decision: 'approve_all',
    });

    expect(result.success).toBe(false);
    expect(result.executed).toBe(false);
    expect(result.message).toMatch(/durably prepared actions/i);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('keeps the explicit unconfigured offline fallback available', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://placeholder.supabase.co');
    vi.stubEnv('SUPABASE_SECRET', 'placeholder-secret');

    const run = await createAgentRunInDb({
      userId: user.id, threadId: user.phone_number, kind: 'reminder_creation',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(run.id).toMatch(/^run-/);
    expect(database.calls).toHaveLength(0);
  });

  it('does not return cached active runs when configured storage has no active row', async () => {
    const cachedRun = await createAgentRunInDb({
      userId: user.id, threadId: user.phone_number, kind: 'generic_operation',
      waitingFor: { type: 'approval' }, expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(getActiveRunFromDb(user.phone_number, user.id)).resolves.toBeNull();
    expect(cachedRun.id).toBe('db-run-id');
  });

  it('requires an approval to freshly load durable prepared rows instead of trusting supplied rows', async () => {
    const storedRun = await createAgentRunInDb({
      userId: user.id, threadId: user.phone_number, kind: 'generic_operation',
      waitingFor: { type: 'approval' }, expiresAt: new Date(Date.now() + 60_000),
    });
    const cachedActions = await stagePreparedActionsInDb(storedRun.id, [{
      callId: 'call-1', domain: 'task', action: 'create', payload: { title: 'Cached action' },
    }]);
    const result = await executeApprovalDecision({
      run: {
        ...storedRun,
        status: 'waiting_for_approval', kind: 'generic_operation',
        preparedActions: cachedActions,
      },
      decision: 'approve_all',
    });

    expect(result.success).toBe(false);
    expect(database.calls.some((call) => call.table === 'prepared_actions' && call.operation === 'select')).toBe(true);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('loads prepared rows from the explicit offline store when supplied actions are empty', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://placeholder.supabase.co');
    vi.stubEnv('SUPABASE_SECRET', 'placeholder-secret');
    const stagedRun = await createApprovalRun({
      user,
      kind: 'generic_operation',
      preparedActions: [{ callId: 'call-1', domain: 'task', action: 'create', payload: { title: 'Offline action' } }],
    });

    const result = await executeApprovalDecision({
      run: { ...stagedRun, preparedActions: [] },
      decision: 'approve_all',
      executionContext: { user },
    });

    expect(result).toMatchObject({ success: true, executed: true, status: 'completed' });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('rejects empty and incomplete prepared-action staging responses', async () => {
    await expect(stagePreparedActionsInDb('run-empty', [])).rejects.toThrow(/no prepared actions/i);
    database.responses.push({
      table: 'prepared_actions',
      operation: 'upsert',
      data: [{ id: 'db-prepared-id', run_id: 'run-partial', call_id: 'call-1', domain: 'task', action: 'create', target_id: null, target_name: null, payload: {}, status: 'prepared' }],
    });

    await expect(stagePreparedActionsInDb('run-partial', [
      { callId: 'call-1', domain: 'task', action: 'create' },
      { callId: 'call-2', domain: 'task', action: 'create' },
    ])).rejects.toThrow(/complete prepared actions/i);

    database.responses.push({
      table: 'prepared_actions',
      operation: 'upsert',
      data: [
        { id: 'prep-1', run_id: 'run-mismatched', call_id: 'call-1', domain: 'task', action: 'create', target_id: null, target_name: null, payload: {}, status: 'prepared' },
        { id: 'prep-2', run_id: 'run-mismatched', call_id: 'call-1', domain: 'task', action: 'create', target_id: null, target_name: null, payload: {}, status: 'prepared' },
      ],
    });
    await expect(stagePreparedActionsInDb('run-mismatched', [
      { callId: 'call-1', domain: 'task', action: 'create' },
      { callId: 'call-2', domain: 'task', action: 'create' },
    ])).rejects.toThrow(/complete prepared actions/i);
  });
});
