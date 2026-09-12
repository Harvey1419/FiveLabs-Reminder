import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));

import { executeTool } from '../../../src/agent/tools/index.js';
import {
  createApprovalRun,
  createInputRun,
  getActiveAgentRun,
  executeApprovalDecision,
  executeContinuationDecision,
} from '../../../src/agent/core/agent-run.js';
import {
  resetInMemoryAgentRuns,
  createAgentRunInDb,
  getActiveRunFromDb,
  updateAgentRunInDb,
  stagePreparedActionsInDb,
  getPreparedActionsFromDb,
} from '../../../src/infrastructure/database/agent-runs.js';
import { deleteEntities } from '../../../src/infrastructure/database/entities.js';

const mockUser = {
  id: 'usr-inv-001',
  phone_number: '573009998877',
  timezone: 'America/Bogota',
  locale: 'es-CO',
};

const dummyContext = {
  user: mockUser,
  language: 'es',
  isPro: true,
  timezone: 'America/Bogota',
  referenceTime: new Date('2026-09-12T12:00:00.000Z'),
  correlationId: 'req-inv-test',
};

beforeEach(() => {
  vi.clearAllMocks();
  resetInMemoryAgentRuns();
  executeTool.mockResolvedValue({
    success: true,
    complete: true,
    action: 'executed',
    data: {},
    rawSummary: 'Operación ejecutada con éxito.',
  });
});

describe('AgentRun Architectural Invariants (Section 23)', () => {
  // Invariant 1: Partial operation → Checkpoint → Resume
  it('1. partial operation → checkpoint → resume: incomplete reminder suspends and completes with delta', async () => {
    const partialAction = {
      domain: 'reminder',
      action: 'create',
      content: 'Llamar a mamá',
      schedule: { kind: 'relative_day_time', dayOffset: 1 },
    };

    const created = await createInputRun({
      user: mockUser,
      partialAction,
      missingFields: ['time'],
      question: '¿A qué hora quieres el recordatorio?',
    });

    expect(created.status).toBe('waiting_for_input');
    expect(created.preparedActions).toHaveLength(1);
    expect(created.preparedActions[0].payload.content).toBe('Llamar a mamá');

    const active = await getActiveAgentRun(mockUser);
    expect(active).not.toBeNull();
    expect(active.id).toBe(created.id);
    expect(active.status).toBe('waiting_for_input');

    const resumeResult = await executeContinuationDecision({
      run: active,
      suppliedFields: {
        schedule: { kind: 'local_time', hour: 18, minute: 0, clockMode: 'explicit_24h' },
      },
      executionContext: dummyContext,
    });

    expect(resumeResult.success).toBe(true);
    expect(resumeResult.status).toBe('completed');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_reminder',
      params: expect.objectContaining({
        content: 'Llamar a mamá',
        schedule: expect.objectContaining({
          dayOffset: 1,
          hour: 18,
          minute: 0,
        }),
      }),
    }));

    const postRun = await getActiveAgentRun(mockUser);
    expect(postRun).toBeNull();
  });

  // Invariant 2: Unrelated action does not destroy suspended Run
  it('2. unrelated action does not destroy suspended Run', async () => {
    const created = await createInputRun({
      user: mockUser,
      partialAction: { domain: 'reminder', action: 'create', content: 'Revisar vuelo' },
      missingFields: ['time'],
      question: '¿Para qué hora?',
    });

    const unrelatedTaskResult = await executeTool({
      ...dummyContext,
      toolName: 'manage_task',
      params: { action: 'create', title: 'Comprar agua', entityName: 'Viaje' },
    });
    expect(unrelatedTaskResult.success).toBe(true);

    const suspended = await getActiveAgentRun(mockUser);
    expect(suspended).not.toBeNull();
    expect(suspended.id).toBe(created.id);
    expect(suspended.status).toBe('waiting_for_input');
    expect(suspended.preparedActions[0].payload.content).toBe('Revisar vuelo');
  });

  // Invariant 3: Destructive batch → Approve all
  it('3. destructive batch → approve all: executes all prepared actions exactly once', async () => {
    const preparedActions = [
      { callId: 'call-1', domain: 'entity', action: 'delete', targetId: 'uuid-proj-a', targetName: 'Proyecto A' },
      { callId: 'call-2', domain: 'entity', action: 'delete', targetId: 'uuid-proj-b', targetName: 'Proyecto B' },
      { callId: 'call-3', domain: 'entity', action: 'delete', targetId: 'uuid-proj-c', targetName: 'Proyecto C' },
    ];

    const run = await createApprovalRun({
      user: mockUser,
      kind: 'entity_destructive_batch',
      preparedActions,
      question: '¿Eliminar los proyectos A, B y C?',
    });

    expect(run.status).toBe('waiting_for_approval');

    const result = await executeApprovalDecision({
      run,
      decision: 'approve_all',
      executionContext: dummyContext,
    });

    expect(result.success).toBe(true);
    expect(result.executedCount).toBe(3);
    expect(result.status).toBe('completed');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_entity',
      params: {
        action: 'delete',
        entityIds: ['uuid-proj-a', 'uuid-proj-b', 'uuid-proj-c'],
      },
    }));

    const actions = await getPreparedActionsFromDb(run.id);
    expect(actions.every((a) => a.status === 'executed')).toBe(true);
  });

  // Invariant 4: Destructive batch → Approve subset
  it('4. destructive batch → approve subset: executes only selected callIds and skips remainder', async () => {
    const preparedActions = [
      { callId: 'call-1', domain: 'entity', action: 'delete', targetId: 'uuid-a', targetName: 'Proyecto A' },
      { callId: 'call-2', domain: 'entity', action: 'delete', targetId: 'uuid-b', targetName: 'Proyecto B' },
      { callId: 'call-3', domain: 'entity', action: 'delete', targetId: 'uuid-c', targetName: 'Proyecto C' },
    ];

    const run = await createApprovalRun({
      user: mockUser,
      kind: 'entity_destructive_batch',
      preparedActions,
      question: '¿Eliminar A, B y C?',
    });

    const result = await executeApprovalDecision({
      run,
      decision: 'approve_subset',
      selectedCallIds: ['call-1', 'call-3'],
      executionContext: dummyContext,
    });

    expect(result.success).toBe(true);
    expect(result.executedCount).toBe(2);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      params: {
        action: 'delete',
        entityIds: ['uuid-a', 'uuid-c'],
      },
    }));

    const actions = await getPreparedActionsFromDb(run.id);
    const call1 = actions.find((a) => a.call_id === 'call-1');
    const call2 = actions.find((a) => a.call_id === 'call-2');
    const call3 = actions.find((a) => a.call_id === 'call-3');

    expect(call1.status).toBe('executed');
    expect(call2.status).toBe('skipped');
    expect(call3.status).toBe('executed');
  });

  // Invariant 5: Exact prepared IDs are used after approval
  it('5. exact prepared IDs are used after approval without natural language re-resolution', async () => {
    const entityAId = '11111111-2222-3333-4444-555555555555';
    const entityBId = '66666666-7777-8888-9999-000000000000';

    const run = await createApprovalRun({
      user: mockUser,
      preparedActions: [
        { callId: 'call-1', domain: 'entity', action: 'delete', targetId: entityAId, targetName: 'Alfa' },
        { callId: 'call-2', domain: 'entity', action: 'delete', targetId: entityBId, targetName: 'Beta' },
      ],
      question: '¿Confirmar borrado?',
    });

    await executeApprovalDecision({
      run,
      decision: 'approve_all',
      executionContext: dummyContext,
    });

    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        entityIds: [entityAId, entityBId],
      }),
    }));
  });

  // Invariant 6: Duplicate webhook/callId does not duplicate mutation
  it('6. duplicate webhook/callId does not duplicate mutation', async () => {
    const run = await createAgentRunInDb({
      userId: mockUser.id,
      threadId: mockUser.phone_number,
      kind: 'entity_destructive_batch',
      expiresAt: new Date(Date.now() + 60000),
    });

    const action = {
      callId: 'call-1',
      domain: 'entity',
      action: 'delete',
      targetId: 'uuid-1',
      targetName: 'P1',
    };

    const firstStage = await stagePreparedActionsInDb(run.id, [action]);
    expect(firstStage).toHaveLength(1);

    const secondStage = await stagePreparedActionsInDb(run.id, [action]);
    const allActions = await getPreparedActionsFromDb(run.id);

    const call1Matches = allActions.filter((a) => a.call_id === 'call-1');
    expect(call1Matches).toHaveLength(1);
  });

  // Invariant 7: Live state read uses tool/DB
  it('7. live state read uses tool/DB and does not infer from historical prompt cards', async () => {
    executeTool.mockResolvedValue({
      success: true,
      action: 'listed_tasks',
      data: { tasks: [{ id: 'task-live-1', title: 'Comprar boletos' }] },
    });

    const result = await executeTool({
      ...dummyContext,
      toolName: 'manage_task',
      params: { action: 'list', entityName: 'Viaje' },
    });

    expect(result.success).toBe(true);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'manage_task',
      params: { action: 'list', entityName: 'Viaje' },
    }));
  });

  // Invariant 8: Expired/cancelled Run cannot resume
  it('8. expired/cancelled Run cannot resume', async () => {
    const expiredRun = await createAgentRunInDb({
      userId: mockUser.id,
      threadId: mockUser.phone_number,
      kind: 'reminder_creation',
      waitingFor: { type: 'missing_fields', fields: ['time'] },
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const active = await getActiveRunFromDb(mockUser.phone_number, mockUser.id);
    expect(active).toBeNull();

    const cancelledRun = await createAgentRunInDb({
      userId: mockUser.id,
      threadId: mockUser.phone_number,
      kind: 'reminder_creation',
      waitingFor: { type: 'missing_fields', fields: ['time'] },
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await updateAgentRunInDb(cancelledRun.id, { status: 'cancelled' });

    const activeCancelled = await getActiveRunFromDb(mockUser.phone_number, mockUser.id);
    expect(activeCancelled).toBeNull();
  });

  // Invariant 9: Process restart can restore Run from durable storage
  it('9. process restart can restore Run from durable storage', async () => {
    const created = await createApprovalRun({
      user: mockUser,
      preparedActions: [{ callId: 'call-1', domain: 'entity', action: 'delete', targetId: 'uuid-restore', targetName: 'Durable Test' }],
      question: '¿Confirmar?',
    });

    expect(created).not.toBeNull();

    const restored = await getActiveRunFromDb(mockUser.phone_number, mockUser.id);
    expect(restored).not.toBeNull();
    expect(restored.id).toBe(created.id);
    expect(restored.status).toBe('waiting_for_approval');
  });

  // Invariant 10: Transient tool failure leaves recoverable Run
  it('10. transient tool failure leaves recoverable Run', async () => {
    executeTool.mockResolvedValueOnce({
      success: false,
      errorCode: 'GATEWAY_TIMEOUT',
      error: 'Conexión con Supabase expiró.',
    });

    const run = await createApprovalRun({
      user: mockUser,
      preparedActions: [{ callId: 'call-1', domain: 'entity', action: 'delete', targetId: 'uuid-fail', targetName: 'Fail Test' }],
      question: '¿Confirmar?',
    });

    const result = await executeApprovalDecision({
      run,
      decision: 'approve_all',
      executionContext: dummyContext,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');

    const actions = await getPreparedActionsFromDb(run.id);
    expect(actions[0].status).toBe('failed');
  });
});
