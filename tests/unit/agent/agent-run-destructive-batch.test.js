import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));
vi.mock('../../../src/agent/providers/client.js', () => ({
  callChatCompletion: vi.fn(),
  callResponseSynthesis: vi.fn().mockResolvedValue(null),
  callPendingTransitionVerification: vi.fn(),
}));
vi.mock('../../../src/features/memory/service.js', () => ({
  retrieveRelevantMemories: vi.fn().mockResolvedValue([]),
  retrieveStandingPreferences: vi.fn().mockResolvedValue([]),
  getProactiveAnchors: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn().mockResolvedValue({ status: 'authorized', plan: 'pro' }),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  createPendingSubscription: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/integrations/mercado-pago/client.js', () => ({
  getOrCreateCanonicalPlan: vi.fn(),
}));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));

import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { clearWorkingMemory, getWorkingMemory } from '../../../src/agent/core/working-memory.js';
import { getActiveAgentRun } from '../../../src/agent/core/agent-run.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';
import { TOOL_NAMES } from '../../../src/agent/contracts/tool-names.js';

const user = {
  id: 'user-agent-run-batch',
  phone_number: '573009998877',
  timezone: 'America/Bogota',
  locale: 'es-CO',
  display_name: 'Carlos',
};

const previewAlfaBeta = [
  { id: 'uuid-alfa-123', name: 'Proyecto Alfa', category: 'project' },
  { id: 'uuid-beta-456', name: 'Proyecto Beta', category: 'project' },
];

function modelResponse(payload) {
  // Approval/continuation messages use their own protocol, not foreground wire.
  const wire = Array.isArray(payload.actions) ? {
    responseLanguage: 'es', responseCapability: 'general', ...payload,
    actions: payload.actions.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const { domain, action, ...fields } = item;
      return { operation: `${domain}.${action}`, ...fields };
    }),
  } : payload;
  return { role: 'assistant', content: JSON.stringify(wire), tool_calls: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearWorkingMemory(user);
});

describe('PR 2: Destructive Batch Entity Deletion via AgentRun (Flows B & C)', () => {
  it('Turn 1: stages an AgentRun in waiting_for_approval when delete preview requires confirmation', async () => {
    executeTool.mockResolvedValueOnce({
      success: false,
      complete: false,
      action: 'entity_deletion_confirmation_required',
      errorCode: 'CONFIRMATION_REQUIRED',
      error: '¿Quieres que elimine 2 proyectos: Proyecto Alfa, Proyecto Beta?',
      rawSummary: '⚠️ *Confirmación necesaria*\n\n¿Quieres que elimine 2 proyectos: Proyecto Alfa, Proyecto Beta?',
      requiresClarification: true,
      pendingClarifications: [{
        type: 'entity_deletion',
        content: 'Eliminación de proyectos',
        question: '¿Quieres que elimine 2 proyectos: Proyecto Alfa, Proyecto Beta?',
      }],
      data: {
        previewEntities: previewAlfaBeta,
      },
    });

    const context = {
      user,
      isPro: true,
      language: 'es',
      timezone: 'America/Bogota',
      referenceTime: new Date('2026-09-12T10:00:00.000Z'),
      correlationId: 'test-batch-t1',
    };

    const intent = {
      actions: [{
        domain: 'entity',
        action: 'delete',
        category: 'project',
        scope: 'all',
        preserveNames: [],
      }],
    };

    const execution = await executeTurnIntent(intent, context);

    expect(execution.records).toHaveLength(1);
    expect(execution.records[0].result.action).toBe('entity_deletion_confirmation_required');

    const activeRun = await getActiveAgentRun(user, context.referenceTime);
    expect(activeRun).not.toBeNull();
    expect(activeRun.status).toBe('waiting_for_approval');
    expect(activeRun.kind).toBe('entity_destructive_batch');
    expect(activeRun.preparedActions).toHaveLength(2);
    expect(activeRun.preparedActions[0]).toMatchObject({
      call_id: 'call-1',
      domain: 'entity',
      action: 'delete',
      target_id: 'uuid-alfa-123',
      target_name: 'Proyecto Alfa',
      status: 'prepared',
    });
    expect(activeRun.preparedActions[1]).toMatchObject({
      call_id: 'call-2',
      domain: 'entity',
      action: 'delete',
      target_id: 'uuid-beta-456',
      target_name: 'Proyecto Beta',
      status: 'prepared',
    });
  });

  it('Turn 2 (approve_all): executes all prepared entity deletions by frozen UUID and marks run completed', async () => {
    // 1. Stage the run via Turn 1
    executeTool.mockResolvedValueOnce({
      success: false,
      complete: false,
      action: 'entity_deletion_confirmation_required',
      errorCode: 'CONFIRMATION_REQUIRED',
      error: '¿Quieres que elimine 2 proyectos: Proyecto Alfa, Proyecto Beta?',
      requiresClarification: true,
      data: { previewEntities: previewAlfaBeta },
    });

    callChatCompletion.mockResolvedValueOnce(modelResponse({
      actions: [{ domain: 'entity', action: 'delete', category: 'project', scope: 'all', preserveNames: [] }],
    }));

    const turn1Result = await routeMessage('Elimina los proyectos Alfa y Beta', user, []);
    expect(turn1Result.plan.type).toBe('turn_intent');

    const runAfterTurn1 = await getActiveAgentRun(user);
    expect(runAfterTurn1).not.toBeNull();
    expect(runAfterTurn1.status).toBe('waiting_for_approval');

    // 2. Turn 2: User approves all
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      relation: 'approval',
      decision: 'approve_all',
      reply: 'Listo, eliminé los dos proyectos.',
    }));

    executeTool.mockResolvedValueOnce({
      success: true,
      action: 'deleted_entities',
      data: {
        deletedCount: 2,
        entities: previewAlfaBeta,
      },
      rawSummary: 'Proyectos eliminados.',
    });

    const turn2Result = await routeMessage('Sí, elimínalos todos', user, []);

    expect(turn2Result.plan.type).toBe('approval_decision');
    expect(turn2Result.plan.decision).toBe('approve_all');
    expect(turn2Result.confirmation).toContain('2 proyectos eliminados');
    expect(turn2Result.confirmation).toContain('Proyecto Alfa');
    expect(turn2Result.confirmation).toContain('Proyecto Beta');
    expect(turn2Result.confirmation).not.toContain('Listo, eliminé los dos proyectos.');

    // Invariant 1: executeTool was called with EXACT frozen UUIDs, not fuzzy text names
    expect(executeTool).toHaveBeenLastCalledWith(expect.objectContaining({
      toolName: TOOL_NAMES.MANAGE_ENTITY,
      params: {
        action: 'delete',
        entityIds: ['uuid-alfa-123', 'uuid-beta-456'],
      },
      clarificationResolution: true,
    }));

    // Invariant 2: Run is now completed and no active run remains
    const runAfterTurn2 = await getActiveAgentRun(user);
    expect(runAfterTurn2).toBeNull(); // getActiveAgentRun only returns active runs (waiting or running)

    // Working memory pending clarifications are clean
    const wm = getWorkingMemory(user);
    expect(wm?.pendingClarifications?.length || 0).toBe(0);
  });

  it('Turn 2 (approve_subset): executes ONLY the selected callIds by frozen UUID and skips the rest', async () => {
    // 1. Stage the run
    executeTool.mockResolvedValueOnce({
      success: false,
      complete: false,
      action: 'entity_deletion_confirmation_required',
      errorCode: 'CONFIRMATION_REQUIRED',
      error: '¿Quieres que elimine 2 proyectos: Proyecto Alfa, Proyecto Beta?',
      requiresClarification: true,
      data: { previewEntities: previewAlfaBeta },
    });

    callChatCompletion.mockResolvedValueOnce(modelResponse({
      actions: [{ domain: 'entity', action: 'delete', category: 'project', scope: 'all', preserveNames: [] }],
    }));

    await routeMessage('Elimina Alfa y Beta', user, []);

    // 2. Turn 2: User selectively approves only Alfa (call-1)
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      relation: 'approval',
      decision: 'approve_subset',
      selectedCallIds: ['call-1'],
      reply: 'Entendido, solo eliminé Proyecto Alfa.',
    }));

    executeTool.mockResolvedValueOnce({
      success: true,
      action: 'deleted_entities',
      data: {
        deletedCount: 1,
        entities: [previewAlfaBeta[0]],
      },
      rawSummary: 'Proyecto eliminado.',
    });

    const turn2Result = await routeMessage('Solo elimina Alfa', user, []);

    expect(turn2Result.plan.type).toBe('approval_decision');
    expect(turn2Result.plan.decision).toBe('approve_subset');
    expect(turn2Result.confirmation).toContain('Proyecto eliminado');
    expect(turn2Result.confirmation).toContain('Proyecto Alfa');
    expect(turn2Result.confirmation).not.toContain('solo eliminé Proyecto Alfa');

    // Invariant: ONLY uuid-alfa-123 was passed for deletion; uuid-beta-456 was untouched
    expect(executeTool).toHaveBeenLastCalledWith(expect.objectContaining({
      toolName: TOOL_NAMES.MANAGE_ENTITY,
      params: {
        action: 'delete',
        entityIds: ['uuid-alfa-123'],
      },
      clarificationResolution: true,
    }));

    const activeRun = await getActiveAgentRun(user);
    expect(activeRun).toBeNull();
  });

  it('Turn 2 (reject / cancel): marks run cancelled and executes zero deletions', async () => {
    // 1. Stage the run
    executeTool.mockResolvedValueOnce({
      success: false,
      complete: false,
      action: 'entity_deletion_confirmation_required',
      errorCode: 'CONFIRMATION_REQUIRED',
      error: '¿Quieres que elimine 2 proyectos: Proyecto Alfa, Proyecto Beta?',
      requiresClarification: true,
      data: { previewEntities: previewAlfaBeta },
    });

    callChatCompletion.mockResolvedValueOnce(modelResponse({
      actions: [{ domain: 'entity', action: 'delete', category: 'project', scope: 'all', preserveNames: [] }],
    }));

    await routeMessage('Elimina los proyectos', user, []);

    // 2. Turn 2: User rejects
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      relation: 'cancel',
      reply: 'Entendido, cancelé la operación.',
    }));

    const turn2Result = await routeMessage('No, no elimines nada', user, []);

    expect(turn2Result.plan.type).toBe('cancelled_run');
    expect(turn2Result.confirmation).toBe('Operación cancelada.');

    // Invariant: executeTool was NOT called again to delete anything
    expect(executeTool).toHaveBeenCalledTimes(1); // only the initial preview from Turn 1

    const activeRun = await getActiveAgentRun(user);
    expect(activeRun).toBeNull();
  });

  it('Turn 2 (unrelated interleaved turn): executes unrelated turn while keeping the AgentRun suspended in DB', async () => {
    // 1. Stage the run
    executeTool.mockResolvedValueOnce({
      success: false,
      complete: false,
      action: 'entity_deletion_confirmation_required',
      errorCode: 'CONFIRMATION_REQUIRED',
      error: '¿Quieres que elimine 2 proyectos: Proyecto Alfa, Proyecto Beta?',
      requiresClarification: true,
      data: { previewEntities: previewAlfaBeta },
    });

    callChatCompletion.mockResolvedValueOnce(modelResponse({
      actions: [{ domain: 'entity', action: 'delete', category: 'project', scope: 'all', preserveNames: [] }],
    }));

    await routeMessage('Elimina los proyectos Alfa y Beta', user, []);

    // 2. Turn 2: User sends an unrelated message ("Crea una tarea comprar leche")
    // Active run interceptor calls model with APPROVAL_DECISION_SCHEMA -> model detects "unrelated"
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      relation: 'unrelated',
    }));

    // Fallthrough to normal operational turn -> model outputs task.create
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      actions: [{ domain: 'task', action: 'create', title: 'Comprar leche', projectless: true }],
    }));

    executeTool.mockResolvedValueOnce({
      success: true,
      action: 'created_task',
      data: { id: 'task-milk-1', title: 'Comprar leche' },
      rawSummary: 'Tarea creada: Comprar leche',
    });

    const turn2Result = await routeMessage('Crea una tarea comprar leche', user, []);

    // Unrelated task executed successfully
    expect(turn2Result.intent).toBe('task');

    // Invariant (Thread != Run != Focus): The AgentRun is STILL active in waiting_for_approval!
    const runStillWaiting = await getActiveAgentRun(user);
    expect(runStillWaiting).not.toBeNull();
    expect(runStillWaiting.status).toBe('waiting_for_approval');
    expect(runStillWaiting.preparedActions).toHaveLength(2);

    // 3. Turn 3: User now resumes and approves the pending deletion
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      relation: 'approval',
      decision: 'approve_all',
      reply: 'Listo, ahora sí eliminé Alfa y Beta.',
    }));

    executeTool.mockResolvedValueOnce({
      success: true,
      action: 'deleted_entities',
      data: { deletedCount: 2, entities: previewAlfaBeta },
      rawSummary: 'Proyectos eliminados.',
    });

    const turn3Result = await routeMessage('Ok, ahora sí elimina los proyectos', user, []);

    expect(turn3Result.plan.type).toBe('approval_decision');
    expect(executeTool).toHaveBeenLastCalledWith(expect.objectContaining({
      toolName: TOOL_NAMES.MANAGE_ENTITY,
      params: { action: 'delete', entityIds: ['uuid-alfa-123', 'uuid-beta-456'] },
    }));

    const finalRun = await getActiveAgentRun(user);
    expect(finalRun).toBeNull();
  });

  it('approve_subset with non-existent callId fails safely without executing any tool calls', async () => {
    executeTool.mockResolvedValueOnce({
      success: false,
      complete: false,
      action: 'entity_deletion_confirmation_required',
      errorCode: 'CONFIRMATION_REQUIRED',
      error: '¿Quieres que elimine 2 proyectos: Proyecto Alfa, Proyecto Beta?',
      requiresClarification: true,
      data: { previewEntities: previewAlfaBeta },
    });

    callChatCompletion.mockResolvedValueOnce(modelResponse({
      actions: [{ domain: 'entity', action: 'delete', category: 'project', scope: 'all', preserveNames: [] }],
    }));

    await routeMessage('Elimina Alfa y Beta', user, []);

    // Model hallucinates an unknown callId
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      relation: 'approval',
      decision: 'approve_subset',
      selectedCallIds: ['call-unknown-999'],
      reply: 'Eliminé el proyecto.',
    }));

    const result = await routeMessage('Elimina solo el proyecto desconocido', user, []);

    expect(result.plan.type).toBe('approval_decision');
    // executeTool was NOT called after Turn 1 preview
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('Invariant 1: supersedes any previous active run when a new run is staged on the same thread', async () => {
    // Stage Run 1
    executeTool.mockResolvedValueOnce({
      success: false,
      complete: false,
      action: 'entity_deletion_confirmation_required',
      errorCode: 'CONFIRMATION_REQUIRED',
      error: '¿Quieres que elimine Alfa?',
      requiresClarification: true,
      data: { previewEntities: [previewAlfaBeta[0]] },
    });

    callChatCompletion.mockResolvedValueOnce(modelResponse({
      actions: [{ domain: 'entity', action: 'delete', target: 'Alfa', scope: 'single' }],
    }));

    await routeMessage('Elimina Alfa', user, []);

    const run1 = await getActiveAgentRun(user);
    expect(run1).not.toBeNull();
    expect(run1.preparedActions[0].target_id).toBe('uuid-alfa-123');

    // User changes mind and initiates deletion of Beta instead
    executeTool.mockResolvedValueOnce({
      success: false,
      complete: false,
      action: 'entity_deletion_confirmation_required',
      errorCode: 'CONFIRMATION_REQUIRED',
      error: '¿Quieres que elimine Beta?',
      requiresClarification: true,
      data: { previewEntities: [previewAlfaBeta[1]] },
    });

    // Model explicitly replaces the previous approval, then initiates delete Beta
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      relation: 'supersede',
    }));
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      actions: [{ domain: 'entity', action: 'delete', target: 'Beta', scope: 'single' }],
    }));

    await routeMessage('Mejor elimina Beta', user, []);

    // Invariant: Exactly one active run exists, and it is the new one (Beta)
    const run2 = await getActiveAgentRun(user);
    expect(run2).not.toBeNull();
    expect(run2.id).not.toBe(run1.id);
    expect(run2.status).toBe('waiting_for_approval');
    expect(run2.preparedActions[0].target_id).toBe('uuid-beta-456');
  });
});

