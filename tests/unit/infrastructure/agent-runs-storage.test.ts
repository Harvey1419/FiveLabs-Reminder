import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown> & { created_at?: string | number; id?: string; status?: string };
type Filter = [string, unknown];
type QueryState = { table: string; operation: string; payload: Row | Row[] | null;
  filters: Filter[]; order?: { column: string; [key: string]: unknown } };
type QueryResult = { data: unknown; error: unknown };
type DatabaseFixture = {
  calls: QueryState[];
  failures: { table: string; operation: string; error: unknown }[];
  responses: { table: string; operation: string; filters?: Filter[]; data: unknown }[];
  rows: Row[]; beforePreparedUpsert: (() => Promise<void>) | null;
  observedActiveRun: Awaited<ReturnType<typeof getActiveRunFromDb>> | undefined;
};
const { database } = vi.hoisted(() => ({
  database: {
    calls: [],
    failures: [],
    responses: [],
    rows: [],
    beforePreparedUpsert: null,
    observedActiveRun: undefined,
  } as DatabaseFixture,
}));

vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: {
    from(table: string) {
      const state: QueryState = { table, operation: 'select', payload: null, filters: [] };
      const execute = async (): Promise<QueryResult> => {
        database.calls.push({ ...state, filters: [...state.filters] });
        if (state.operation === 'upsert' && state.table === 'prepared_actions' && database.beforePreparedUpsert) {
          const beforePreparedUpsert = database.beforePreparedUpsert;
          database.beforePreparedUpsert = null;
          await beforePreparedUpsert();
        }
        const failureIndex = database.failures.findIndex((failure) => (
          failure.table === state.table && failure.operation === state.operation
        ));
        if (failureIndex >= 0) {
          const { error } = database.failures.splice(failureIndex, 1)[0]!;
          return { data: null, error };
        }
        const responseIndex = database.responses.findIndex((response) => (
          response.table === state.table
          && response.operation === state.operation
          && (!response.filters || response.filters.every(([column, value]) => state.filters.some(([actualColumn, actualValue]) => actualColumn === column && actualValue === value)))
        ));
        if (responseIndex >= 0) {
          const { data } = database.responses.splice(responseIndex, 1)[0]!;
          return { data, error: null };
        }
        if (state.operation === 'insert' && state.table === 'agent_runs') {
          const row = { id: 'db-run-id', created_at: new Date().toISOString(), ...state.payload as Row };
          database.rows.push(row);
          return { data: row, error: null };
        }
        if (state.operation === 'select' && state.table === 'agent_runs') {
          const rows = database.rows.filter((candidate) => state.filters.every(([column, value]) => {
            if (column.endsWith('>')) return (candidate[column.slice(0, -1)] as string) > (value as string);
            return Array.isArray(value) ? value.includes(candidate[column]) : candidate[column] === value;
          }));
          if (state.order?.column === 'created_at') {
            rows.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
          }
          return { data: rows, error: null };
        }
        if (state.operation === 'upsert') {
          const rows = (state.payload as Row[]).map((row) => ({ id: 'db-prepared-id', ...row }));
          return { data: rows, error: null };
        }
        if (state.operation === 'update' && state.table === 'agent_runs') {
          const row = database.rows.find((candidate) => state.filters.every(([column, value]) => {
            if (column.endsWith('>')) return (candidate[column.slice(0, -1)] as string) > (value as string);
            return Array.isArray(value) ? value.includes(candidate[column]) : candidate[column] === value;
          }));
          if (state.filters.some(([column]) => column === 'status')) {
            if (!row) return { data: null, error: null };
            Object.assign(row, state.payload);
            return { data: row, error: null };
          }
          if (row) {
            Object.assign(row, state.payload);
            return { data: row, error: null };
          }
          return { data: { id: 'db-run-id', ...state.payload as Row }, error: null };
        }
        if (state.operation === 'update' && state.table === 'prepared_actions') {
          return { data: { id: 'db-prepared-id', ...state.payload as Row, call_id: 'call-1' }, error: null };
        }
        if (state.operation === 'insert' && state.table === 'agent_execution_events') {
          return { data: { id: 'db-event-id', ...state.payload as Row }, error: null };
        }
        return { data: [], error: null };
      };
      const builder = {
        insert(payload: Row) { state.operation = 'insert'; state.payload = payload; return builder; },
        update(payload: Row) { state.operation = 'update'; state.payload = payload; return builder; },
        upsert(payload: Row[]) { state.operation = 'upsert'; state.payload = payload; return builder; },
        select() { return builder; },
        single: execute,
        maybeSingle: execute,
        eq(column: string, value: unknown) { state.filters.push([column, value]); return builder; },
        in(column: string, value: unknown) { state.filters.push([column, value]); return builder; },
        gt(column: string, value: unknown) { state.filters.push([`${column}>`, value]); return builder; },
        order(column: string, options: Record<string, unknown> = {}) { state.order = { column, ...options }; return builder; },
        then(resolve?: (result: QueryResult) => unknown, reject?: (reason: unknown) => unknown) { return execute().then(resolve, reject); },
      };
      return builder;
    },
  },
}));

import {
  cancelActiveInputRunFromDb,
  createAgentRunInDb,
  getActiveRunFromDb,
  getPreparedActionsFromDb,
  recordExecutionEventInDb,
  resetInMemoryAgentRuns,
  stagePreparedActionsInDb,
  updateAgentRunInDb,
  updatePreparedActionInDb,
} from '../../../src/infrastructure/database/agent-runs.js';
import { createApprovalRun as createApproval, createInputRun, executeApprovalDecision as approve } from '../../../src/agent/core/agent-run.js';
import { executeTool } from '../../../src/agent/tools/index.js';
// Keep historical incomplete approval fixtures intact at the consumed test boundary.
type ApprovalOptions = Parameters<typeof createApproval>[0];
type PreparedInput = NonNullable<ApprovalOptions['preparedActions']>[number];
function createApprovalRun(options: Omit<ApprovalOptions, 'preparedActions'> & {
  preparedActions?: readonly (Omit<PreparedInput, 'payload'> & Partial<Pick<PreparedInput, 'payload'>>)[];
}) {
  return createApproval(options as ApprovalOptions);
}
function executeApprovalDecision(options: Omit<Parameters<typeof approve>[0], 'run'> & { run: unknown }) {
  return approve(options as Parameters<typeof approve>[0]);
}


vi.mock('../../../src/agent/tools/index.js', () => ({ executeTool: vi.fn() }));

const failure = { message: 'simulated durable storage failure', code: 'TEST_STORAGE_FAILURE' };
const user = { id: 'user-test', phone_number: 'phone-test' };

beforeEach(() => {
  database.calls.length = 0;
  database.failures.length = 0;
  database.responses.length = 0;
  database.rows.length = 0;
  database.beforePreparedUpsert = null;
  database.observedActiveRun = undefined;
  resetInMemoryAgentRuns();
  vi.stubEnv('SUPABASE_URL', 'https://unit-test.supabase.co');
  vi.stubEnv('SUPABASE_SECRET', 'unit-test-secret');
  vi.clearAllMocks();
  untrustedResultMock(executeTool).mockResolvedValue({ success: true, complete: true, action: 'executed', data: {} });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AgentRun durable storage boundary', () => {
  it('keeps a replacement invisible to active-run queries until stage and retirement are complete', async () => {
    const now = new Date();
    const oldRun = {
      id: 'old-pending', user_id: user.id, thread_id: user.phone_number,
      status: 'waiting_for_input', kind: 'reminder_creation', waiting_for: { type: 'missing_fields' },
      context: {}, created_at: new Date(now.getTime() - 60_000).toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
    };
    database.rows.push(oldRun);
    database.beforePreparedUpsert = async () => {
      database.observedActiveRun = await getActiveRunFromDb(user.phone_number, user.id, now);
    };

    const replacement = await createInputRun({
      user,
      partialAction: { domain: 'reminder', action: 'create', content: 'Replacement', missingFields: ['schedule'] },
      missingFields: ['schedule'],
      referenceTime: now,
    });

    expect(database.observedActiveRun?.id).toBe(oldRun.id);
    expect(replacement!.status).toBe('waiting_for_input');
    expect(database.rows.find((row) => row.id === 'db-run-id')?.status).toBe('waiting_for_input');
  });

  it('keeps a staged candidate inert when cancellation fails without a cleanup write', async () => {
    const now = new Date();
    const oldRun = {
      id: 'old-pending', user_id: user.id, thread_id: user.phone_number,
      status: 'waiting_for_input', kind: 'reminder_creation', waiting_for: { type: 'missing_fields' },
      context: {}, created_at: new Date(now.getTime() - 60_000).toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
    };
    database.rows.push(oldRun);
    database.failures.push({ table: 'agent_runs', operation: 'update', error: failure });
    database.beforePreparedUpsert = async () => {
      database.observedActiveRun = await getActiveRunFromDb(user.phone_number, user.id, now);
    };

    await expect(createInputRun({
      user,
      partialAction: { domain: 'reminder', action: 'create', content: 'Replacement', missingFields: ['schedule'] },
      missingFields: ['schedule'],
      referenceTime: now,
    })).rejects.toThrow(/conditional AgentRun status update/i);

    expect(database.observedActiveRun?.id).toBe(oldRun.id);
    expect(oldRun.status).toBe('waiting_for_input');
    expect(database.rows.find((row) => row.id === 'db-run-id')?.status).toBe('failed');
    expect(database.calls.filter((call) => call.table === 'agent_runs' && call.operation === 'update')).toHaveLength(1);
  });

  it('retains staged payload and refuses activation when the candidate status claim fails', async () => {
    const now = new Date();
    const oldRun = {
      id: 'old-pending', user_id: user.id, thread_id: user.phone_number,
      status: 'waiting_for_input', kind: 'reminder_creation', waiting_for: { type: 'missing_fields' },
      context: {}, created_at: new Date(now.getTime() - 60_000).toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
    };
    database.rows.push(oldRun);
    database.responses.push(
      { table: 'agent_runs', operation: 'update', filters: [['id', 'db-run-id'], ['status', 'failed']], data: null },
    );

    const replacement = await createInputRun({
      user,
      partialAction: { domain: 'reminder', action: 'create', content: 'Replacement', missingFields: ['schedule'] },
      missingFields: ['schedule'],
      referenceTime: now,
    });

    expect(replacement).toMatchObject({ activationFailed: true, status: 'failed' });
    expect(replacement!.preparedActions[0]!.payload.content).toBe('Replacement');
    expect(oldRun.status).toBe('cancelled');
    expect(database.rows.find((row) => row.id === 'db-run-id')?.status).toBe('failed');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('atomically permits only one owner-bound cancellation of the same pending input run', async () => {
    const now = new Date();
    database.rows.push({
      id: 'pending-cas', user_id: user.id, thread_id: user.phone_number,
      status: 'waiting_for_input', expires_at: new Date(now.getTime() + 60_000).toISOString(),
    });

    const results = await Promise.all([
      cancelActiveInputRunFromDb({ runId: 'pending-cas', userId: user.id, now }),
      cancelActiveInputRunFromDb({ runId: 'pending-cas', userId: user.id, now }),
    ]);

    expect(results.sort()).toEqual([false, true]);
    const cancellation = database.calls.filter((call) => call.table === 'agent_runs' && call.operation === 'update');
    expect(cancellation).toHaveLength(2);
    expect(cancellation.every((call) => JSON.stringify(call.filters).includes('["id","pending-cas"]'))).toBe(true);
    expect(cancellation.every((call) => JSON.stringify(call.filters).includes(JSON.stringify(['user_id', user.id])))).toBe(true);
    expect(cancellation.every((call) => JSON.stringify(call.filters).includes('["status","waiting_for_input"]'))).toBe(true);
  });

  it('uses atomic compare-and-set in the explicit offline store too', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://placeholder.supabase.co');
    vi.stubEnv('SUPABASE_SECRET', 'placeholder-secret');
    const pending = await createAgentRunInDb({
      userId: user.id, threadId: user.phone_number, kind: 'reminder_creation',
      waitingFor: { type: 'missing_fields' }, expiresAt: new Date(Date.now() + 60_000),
    });

    const results = await Promise.all([
      cancelActiveInputRunFromDb({ runId: pending.id, userId: user.id }),
      cancelActiveInputRunFromDb({ runId: pending.id, userId: user.id }),
    ]);

    expect(results.sort()).toEqual([false, true]);
  });

  it('surfaces configured compare-and-set storage failures instead of claiming cancellation', async () => {
    database.rows.push({
      id: 'pending-cas-error', user_id: user.id, thread_id: user.phone_number,
      status: 'waiting_for_input', expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    database.failures.push({ table: 'agent_runs', operation: 'update', error: failure });

    await expect(cancelActiveInputRunFromDb({ runId: 'pending-cas-error', userId: user.id }))
      .rejects.toThrow(/conditional AgentRun status update/i);
  });

  it.each(['insert', 'stage'])('preserves the old pending input when replacement %s fails', async (failurePoint) => {
    const oldRun = {
      id: 'old-pending', user_id: user.id, thread_id: user.phone_number,
      status: 'waiting_for_input', kind: 'reminder_creation', waiting_for: { type: 'missing_fields' },
      context: {}, expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    database.rows.push(oldRun);
    database.responses.push({ table: 'agent_runs', operation: 'select', data: [oldRun] });
    if (failurePoint === 'insert') {
      database.failures.push({ table: 'agent_runs', operation: 'insert', error: failure });
    } else {
      database.failures.push({ table: 'prepared_actions', operation: 'upsert', error: failure });
    }

    await expect(createInputRun({
      user,
      partialAction: { domain: 'reminder', action: 'create', content: 'Replacement', missingFields: ['schedule'] },
      missingFields: ['schedule'],
      expiresAtMs: 60_000,
    })).rejects.toThrow();

    expect(oldRun.status).toBe('waiting_for_input');
  });

  it('marks a staged replacement failed when its exact pending-run cancellation claim loses', async () => {
    const oldRun = {
      id: 'old-pending', user_id: user.id, thread_id: user.phone_number,
      status: 'waiting_for_input', kind: 'reminder_creation', waiting_for: { type: 'missing_fields' },
      context: {}, expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    database.rows.push(oldRun);
    database.responses.push(
      { table: 'agent_runs', operation: 'select', data: [oldRun] },
      { table: 'agent_runs', operation: 'update', data: null },
    );

    const replacement = await createInputRun({
      user,
      partialAction: { domain: 'reminder', action: 'create', content: 'Replacement', missingFields: ['schedule'] },
      missingFields: ['schedule'],
      supersedesRunId: oldRun.id,
      referenceTime: new Date(),
    });

    expect(replacement).toBeNull();
    expect(oldRun.status).toBe('waiting_for_input');
    expect(database.rows.find((row) => row.id === 'db-run-id')?.status).toBe('failed');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('resumes a serialized pending run after module-cache eviction using its stored original time context', async () => {
    vi.resetModules();
    const freshStore = await import('../../../src/infrastructure/database/agent-runs.js');
    freshStore.resetInMemoryAgentRuns();
    const originalReference = new Date('2026-10-02T06:55:00.000Z');
    const resumedAt = new Date('2026-10-02T07:05:00.000Z');
    const serializedRun = {
      id: 'durable-restart-run', user_id: user.id, thread_id: user.phone_number,
      status: 'waiting_for_input', kind: 'reminder_creation',
      waiting_for: { type: 'missing_fields', fields: ['time'], question: 'What time?' },
      context: { referenceTime: originalReference.toISOString(), timezone: 'America/Los_Angeles' },
      expires_at: new Date(resumedAt.getTime() + 60_000).toISOString(),
    };
    const serializedPrepared = {
      id: 'durable-prepared', run_id: serializedRun.id, call_id: 'call-1',
      domain: 'reminder', action: 'create', status: 'prepared', execution_fact: null,
      payload: { domain: 'reminder', action: 'create', content: 'Restarted reminder', schedule: { kind: 'relative_day_time', dayOffset: 1 }, missingFields: ['time'] },
    };
    database.rows.push(serializedRun);
    database.responses.push(
      { table: 'agent_runs', operation: 'select', data: [serializedRun] },
      { table: 'prepared_actions', operation: 'select', data: [serializedPrepared] },
      { table: 'prepared_actions', operation: 'select', data: [serializedPrepared] },
      { table: 'agent_runs', operation: 'select', data: [] },
    );
    const freshCore = await import('../../../src/agent/core/agent-run.js');
    const activeRun = await freshCore.getActiveAgentRun(user, resumedAt);
    const execution = await freshCore.executeContinuationDecision({
      run: activeRun!,
      suppliedFields: { schedule: { kind: 'local_time', hour: 7, minute: 0, clockMode: 'explicit_24h' } },
      executionContext: { user: { ...user, timezone: 'America/Bogota' }, language: 'en', timezone: 'America/Bogota', referenceTime: resumedAt },
      executeTool: executeTool as unknown as NonNullable<Parameters<typeof freshCore.executeContinuationDecision>[0]['executeTool']>,
    });

    expect(execution.success).toBe(true);
    expect((untrustedResultMock(executeTool).mock.calls[0]![0] as { params: { items: { targetTime: string }[] } }).params.items[0]!.targetTime).toBe('2026-10-02T14:00:00.000Z');
    expect(await freshCore.getActiveAgentRun(user, resumedAt)).toBeNull();
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

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
    expect((inserted!.payload as Row).kind).toBe('generic_operation');
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
      call.table === 'agent_runs' && call.operation === 'update' && (call.payload as Row).status === 'failed'
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
    database.responses.push({ table: 'agent_runs', operation: 'select', data: [] });

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
