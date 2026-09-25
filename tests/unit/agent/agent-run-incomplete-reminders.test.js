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
  id: 'user-agent-run-incomplete',
  phone_number: '573007776655',
  timezone: 'America/Bogota',
  locale: 'es-CO',
  display_name: 'Mateo',
};

function modelResponse(payload) {
  return { role: 'assistant', content: JSON.stringify(payload), tool_calls: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearWorkingMemory(user);
});

describe('PR 3: Incomplete Reminders & Continuations via AgentRun (Flow A)', () => {
  it('Turn 1: stages an AgentRun in waiting_for_input when reminder lacks schedule', async () => {
    const context = {
      user,
      isPro: true,
      language: 'es',
      timezone: 'America/Bogota',
      referenceTime: new Date('2026-09-12T10:00:00.000Z'),
      correlationId: 'test-incomplete-t1',
    };

    const intent = {
      actions: [{
        domain: 'reminder',
        action: 'create',
        content: 'Llamar al cardiólogo',
        missingFields: ['schedule'],
      }],
      clarification: {
        domain: 'clarification',
        action: 'request',
        question: '¿Cuándo quieres que te recuerde “Llamar al cardiólogo”?',
      },
    };

    const execution = await executeTurnIntent(intent, context);

    expect(execution.records).toHaveLength(1);
    expect(execution.records[0].result.requiresClarification).toBe(true);

    // Invariant: Legacy working memory pendingIntent is NOT contaminated
    const wm = getWorkingMemory(user);
    expect(wm?.pendingIntent).toBeUndefined();

    // AgentRun state machine has staged run in waiting_for_input
    const activeRun = await getActiveAgentRun(user, context.referenceTime);
    expect(activeRun).not.toBeNull();
    expect(activeRun.status).toBe('waiting_for_input');
    expect(activeRun.kind).toBe('reminder_creation');
    expect(activeRun.waiting_for).toMatchObject({
      type: 'missing_fields',
      fields: ['schedule'],
      question: '¿Cuándo quieres que te recuerde “Llamar al cardiólogo”?',
    });
    expect(activeRun.preparedActions).toHaveLength(1);
    expect(activeRun.preparedActions[0]).toMatchObject({
      call_id: 'call-1',
      domain: 'reminder',
      action: 'create',
      status: 'prepared',
      payload: expect.objectContaining({
        content: 'Llamar al cardiólogo',
      }),
    });
  });

  it('Turn 2 (resume): deterministic continuation merges delta schedule, calls executeTool once, and completes run', async () => {
    // 1. Stage Turn 1 via routeMessage
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      actions: [{
        domain: 'reminder',
        action: 'create',
        content: 'Comprar boletos de concierto',
        missingFields: ['time'],
      }],
      clarification: {
        domain: 'clarification',
        action: 'request',
        question: '¿A qué hora quieres que te recuerde “Comprar boletos de concierto”?',
      },
    }));

    const turn1Result = await routeMessage('Recuérdame comprar boletos de concierto', user, []);
    expect(turn1Result.confirmation).toContain('¿A qué hora');

    const stagedRun = await getActiveAgentRun(user);
    expect(stagedRun).not.toBeNull();
    expect(stagedRun.status).toBe('waiting_for_input');

    // 2. Turn 2: User supplies the missing time ("Mañana a las 4pm")
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      relation: 'resume',
      suppliedFields: {
        schedule: {
          kind: 'relative_day_time',
          dayOffset: 1,
          hour: 16,
          minute: 0,
          clockMode: 'explicit_24h',
        },
      },
      reply: 'Listo, te recordaré comprar boletos de concierto mañana a las 4:00 PM.',
    }));

    executeTool.mockResolvedValueOnce({
      success: true,
      action: 'created_reminder',
      data: {
        id: 'rem-concert-1',
        content: 'Comprar boletos de concierto',
        targetTime: '2026-09-13T21:00:00.000Z',
      },
      rawSummary: 'Recordatorio programado para mañana a las 4:00 PM.',
    });

    const turn2Result = await routeMessage('Mañana a las 4pm', user, []);

    expect(turn2Result.intent).toBe('reminder');
    expect(turn2Result.plan.type).toBe('continuation_decision');
    expect(turn2Result.confirmation).toContain('Recordatorio programado para mañana a las 4:00 PM.');
    expect(turn2Result.confirmation).not.toContain('Listo, te recordaré comprar boletos de concierto');

    // Invariant: executeTool was called with merged payload and canonical ISO targetTime
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenLastCalledWith(expect.objectContaining({
      toolName: TOOL_NAMES.MANAGE_REMINDER,
      params: expect.objectContaining({
        action: 'create',
        items: [
          expect.objectContaining({
            content: 'Comprar boletos de concierto',
            targetTime: expect.any(String),
          }),
        ],
      }),
      clarificationResolution: true,
    }));

    // Invariant: Run is completed and no active run remains in DB
    const activeRunAfterResume = await getActiveAgentRun(user);
    expect(activeRunAfterResume).toBeNull();
  });

  it('Turn 2 (unrelated): interleaved turn executes without error while AgentRun stays suspended in DB', async () => {
    // 1. Stage Turn 1
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      actions: [{
        domain: 'reminder',
        action: 'create',
        content: 'Renovar pasaporte',
        missingFields: ['schedule'],
      }],
      clarification: {
        domain: 'clarification',
        action: 'request',
        question: '¿Cuándo quieres que te recuerde “Renovar pasaporte”?',
      },
    }));

    await routeMessage('Recuérdame renovar pasaporte', user, []);

    const runAfterTurn1 = await getActiveAgentRun(user);
    expect(runAfterTurn1).not.toBeNull();
    expect(runAfterTurn1.status).toBe('waiting_for_input');

    // 2. Turn 2: User changes subject and creates a task ("Anota comprar café")
    // Interceptor asks model with CONTINUATION_DECISION_SCHEMA -> model outputs relation: "unrelated"
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      relation: 'unrelated',
    }));

    // Falls through to normal TurnIntent schema -> model outputs task.create
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      actions: [{
        domain: 'task',
        action: 'create',
        title: 'Comprar café',
        projectless: true,
      }],
    }));

    executeTool.mockResolvedValueOnce({
      success: true,
      action: 'created_task',
      data: { id: 'task-coffee-1', title: 'Comprar café' },
      rawSummary: 'Tarea creada: Comprar café',
    });

    const turn2Result = await routeMessage('Anota comprar café', user, []);

    // Unrelated task executed cleanly
    expect(turn2Result.intent).toBe('task');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenLastCalledWith(expect.objectContaining({
      toolName: TOOL_NAMES.MANAGE_TASK,
    }));

    // Invariant (Thread != Run != Focus): AgentRun is STILL waiting_for_input in DB!
    const runStillSuspended = await getActiveAgentRun(user);
    expect(runStillSuspended).not.toBeNull();
    expect(runStillSuspended.id).toBe(runAfterTurn1.id);
    expect(runStillSuspended.status).toBe('waiting_for_input');

    // 3. Turn 3: User finally answers the reminder question ("El viernes a las 10am")
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      relation: 'resume',
      suppliedFields: {
        schedule: {
          kind: 'weekday_time',
          weekday: 'friday',
          hour: 10,
          minute: 0,
          clockMode: 'explicit_24h',
        },
      },
      reply: 'Listo, te recordaré renovar pasaporte el viernes a las 10:00 AM.',
    }));

    executeTool.mockResolvedValueOnce({
      success: true,
      action: 'created_reminder',
      data: { id: 'rem-pass-1', content: 'Renovar pasaporte' },
      rawSummary: 'Recordatorio creado.',
    });

    const turn3Result = await routeMessage('El viernes a las 10am', user, []);

    expect(turn3Result.plan.type).toBe('continuation_decision');
    expect(executeTool).toHaveBeenLastCalledWith(expect.objectContaining({
      toolName: TOOL_NAMES.MANAGE_REMINDER,
      params: expect.objectContaining({
        action: 'create',
        items: [
          expect.objectContaining({
            content: 'Renovar pasaporte',
            targetTime: expect.any(String),
          }),
        ],
      }),
    }));

    // Run completed
    const runAfterTurn3 = await getActiveAgentRun(user);
    expect(runAfterTurn3).toBeNull();
  });

  it('Turn 2 (cancel): user explicitly cancels continuation -> run cancelled, zero reminders created', async () => {
    // 1. Stage Turn 1
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      actions: [{
        domain: 'reminder',
        action: 'create',
        content: 'Ir al gimnasio',
        missingFields: ['schedule'],
      }],
      clarification: {
        domain: 'clarification',
        action: 'request',
        question: '¿Cuándo quieres que te recuerde “Ir al gimnasio”?',
      },
    }));

    await routeMessage('Recuérdame ir al gimnasio', user, []);

    // 2. Turn 2: User cancels ("No, olvídalo")
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      relation: 'cancel',
      reply: 'Entendido, cancelé el recordatorio.',
    }));

    const turn2Result = await routeMessage('No, olvídalo', user, []);

    expect(turn2Result.plan.type).toBe('cancelled_run');
    expect(turn2Result.confirmation).toBe('Entendido, cancelé el recordatorio.');

    // Invariant: No tool calls were made to create a reminder
    expect(executeTool).not.toHaveBeenCalled();

    // Invariant: Run is cancelled, getActiveAgentRun returns null
    const activeRun = await getActiveAgentRun(user);
    expect(activeRun).toBeNull();
  });

  it('Invariant: expired AgentRun past TTL returns null and does not intercept next turns', async () => {
    const t0 = new Date('2026-09-12T12:00:00.000Z');

    // 1. Stage Turn 1 with explicit referenceTime
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      actions: [{
        domain: 'reminder',
        action: 'create',
        content: 'Tomar medicina',
        missingFields: ['schedule'],
      }],
      clarification: {
        domain: 'clarification',
        action: 'request',
        question: '¿A qué hora quieres que te recuerde “Tomar medicina”?',
      },
    }));

    await routeMessage('Recuérdame tomar medicina', user, [], {
      referenceTime: t0,
    });

    // Run is active at T0 + 5 minutes
    const tPlus5m = new Date(t0.getTime() + 5 * 60 * 1000);
    const activeAt5m = await getActiveAgentRun(user, tPlus5m);
    expect(activeAt5m).not.toBeNull();
    expect(activeAt5m.status).toBe('waiting_for_input');

    // Run is expired at T0 + 16 minutes (TTL is 15 minutes)
    const tPlus16m = new Date(t0.getTime() + 16 * 60 * 1000);
    const activeAt16m = await getActiveAgentRun(user, tPlus16m);
    expect(activeAt16m).toBeNull();

    // Turn at T0 + 16 minutes does NOT trigger continuation interceptor; routes as normal TurnIntent
    callChatCompletion.mockResolvedValueOnce(modelResponse({
      actions: [{ domain: 'conversation', action: 'reply', content: '¡Hola! ¿En qué te ayudo?' }],
    }));

    const nextTurn = await routeMessage('Hola', user, [], {
      referenceTime: tPlus16m,
    });

    expect(nextTurn.plan.type).not.toBe('continuation_decision');
  });
});
