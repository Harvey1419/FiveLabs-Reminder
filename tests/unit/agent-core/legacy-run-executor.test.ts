import { describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '@templelabs/contracts';
import {
  createLegacyRunExecutor, type LegacyActiveRun, type LegacyPreparedAction,
  type LegacyActiveRunRuntime, type LegacyExecutionDependencies, type LegacyDomainCall,
} from '../../../src/agent/core/active-run-executor.js';

const run: LegacyActiveRun = {
  id: 'run', user_id: 'owner', thread_id: 'thread', kind: 'generic_operation',
  status: 'waiting_for_approval', context: {}, waiting_for: null, expires_at: '2026-10-13T00:00:00Z',
};
function action(callId: string, overrides: Partial<LegacyPreparedAction> = {}): LegacyPreparedAction {
  return { run_id: run.id, call_id: callId, domain: 'task', action: 'delete', target_id: callId,
    target_name: callId, payload: { action: 'delete', targetId: callId }, status: 'prepared', execution_fact: null, ...overrides };
}
function fixture(actions: readonly LegacyPreparedAction[]) {
  const order: string[] = [];
  const storage: LegacyActiveRunRuntime = {
    getPreparedActions: vi.fn(async () => actions),
    claimRun: vi.fn(async () => true),
    beforeWrite: vi.fn(async () => { order.push('authorize'); }),
    updatePreparedAction: vi.fn(async (_runId, callId, updates) => {
      order.push(`${callId}:${updates.status}:${updates.executionFact && typeof updates.executionFact === 'object' && !Array.isArray(updates.executionFact) ? updates.executionFact.outcome ?? 'observed' : 'none'}`);
      return updates;
    }),
    updateRun: vi.fn(async (_id, updates) => updates),
    recordEvent: vi.fn(async event => event),
  };
  const executeTool = vi.fn(async (): Promise<JsonObject> => { order.push('tool'); return { success: true }; });
  const buildDomainCall = vi.fn((payload: JsonObject): LegacyDomainCall => ({ valid: true, toolName: 'manage_task', params: payload }));
  const dependencies: LegacyExecutionDependencies = {
    toolNames: { MANAGE_TASK: 'manage_task', MANAGE_ENTITY: 'manage_entity', MANAGE_PROJECT: 'manage_project', MANAGE_REMINDER: 'manage_reminder' },
    executionRuntime: storage, executeTool, buildDomainCall,
    mergePendingSchedule: (_original, delta) => delta ?? null,
    pendingInputForValidation: () => null,
    createExecutionFact: ({ result }) => ({ outcome: result.outcome ?? (result.success ? 'success' : 'failure') }),
    updateWorkingMemoryFromFacts: vi.fn(),
  };
  return { dependencies, storage, executeTool, buildDomainCall, order, executor: createLegacyRunExecutor(dependencies) };
}

describe('strict legacy execution with host-owned ports', () => {
  it.each(['approval', 'continuation'] as const)('observes a lost %s claim exclusively through injected storage', async kind => {
    const host = fixture([]), scoped = fixture([action('observed', { status: 'executed', execution_fact: {
      success: true, _domainCall: { toolName: 'manage_task', params: { action: 'delete' } },
    } })]);
    vi.mocked(scoped.storage.claimRun).mockResolvedValue(false);
    const options = { run, executionRuntime: scoped.storage, executionContext: { user: { id: 'owner' } } };
    const result = kind === 'approval'
      ? await host.executor.executeApprovalDecision({ ...options, decision: 'approve_all' })
      : await host.executor.executeContinuationDecision(options);
    expect(result).toMatchObject({ success: false, executed: false, status: 'not_acquired', results: [{ callId: 'observed', result: { success: true } }] });
    expect(host.storage.getPreparedActions).not.toHaveBeenCalled();
    expect(scoped.storage.getPreparedActions).toHaveBeenCalledTimes(2);
    expect(host.executeTool).not.toHaveBeenCalled();
    expect(scoped.storage.updatePreparedAction).not.toHaveBeenCalled();
  });

  it('persists uncertainty before dispatch and stops the batch after an unobservable write', async () => {
    const f = fixture([action('first'), action('second')]);
    f.executeTool.mockImplementation(async () => { f.order.push('tool'); throw new Error('lost response'); });
    const result = await f.executor.executeApprovalDecision({ run, decision: 'approve_all' });
    expect(result).toMatchObject({ success: false, status: 'failed', executedCount: 1 });
    expect(f.order).toEqual(['authorize', 'first:failed:unknown', 'tool', 'first:failed:unknown']);
    expect(f.executeTool).toHaveBeenCalledTimes(1);
  });

  it('never dispatches if durable fencing fails', async () => {
    const f = fixture([action('first')]);
    vi.mocked(f.storage.updatePreparedAction).mockRejectedValue(new Error('storage unavailable'));
    await expect(f.executor.executeContinuationDecision({ run })).rejects.toThrow('storage unavailable');
    expect(f.executeTool).not.toHaveBeenCalled();
  });

  it('retains stored execution observations without repeating them on continuation', async () => {
    const f = fixture([action('done', { status: 'executed', execution_fact: { success: true,
      _domainCall: { toolName: 'manage_task', params: { action: 'delete', targetId: 'done' } },
    } }), action('pending')]);
    const result = await f.executor.executeContinuationDecision({ run, actionInputs: [{ callId: 'pending', fields: { title: 'corrected' } }] });
    expect(result).toMatchObject({ success: true, status: 'completed', results: [{ callId: 'done' }, { callId: 'pending' }] });
    expect(f.executeTool).toHaveBeenCalledTimes(1);
    expect(f.buildDomainCall).toHaveBeenCalledTimes(1);
    expect(f.buildDomainCall).toHaveBeenCalledWith(expect.objectContaining({ title: 'corrected', targetId: 'pending' }), expect.any(Object));
  });

  it('leaves invalid resumed drafts pending without any external write', async () => {
    const f = fixture([action('pending')]);
    f.buildDomainCall.mockReturnValue({ valid: false, errorCode: 'MISSING_SCHEDULE' });
    const executor = createLegacyRunExecutor({ ...f.dependencies,
      pendingInputForValidation: () => ({ fields: ['time'], question: '¿A qué hora?' }),
    });
    const result = await executor.executeContinuationDecision({ run });
    expect(result).toMatchObject({ success: false, status: 'waiting_for_input' });
    expect(f.executeTool).not.toHaveBeenCalled();
    expect(f.storage.beforeWrite).not.toHaveBeenCalled();
    expect(f.storage.updateRun).toHaveBeenCalledWith('run', { status: 'waiting_for_input', waitingFor: { fields: ['time'], question: '¿A qué hora?' } });
  });
});
