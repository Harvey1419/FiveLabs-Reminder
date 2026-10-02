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
import * as agentRunModule from '../../../src/agent/core/agent-run.js';
import {
  executeContinuationDecision,
  formatActiveRunPrompt,
  getActiveAgentRun,
} from '../../../src/agent/core/agent-run.js';
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
  vi.restoreAllMocks();
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
    expect(activeRun.context).toMatchObject({
      referenceTime: context.referenceTime.toISOString(),
      timezone: context.timezone,
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
    expect(turn2Result.confirmation).toBe('Operación cancelada.');

    // Invariant: No tool calls were made to create a reminder
    expect(executeTool).not.toHaveBeenCalled();

    // Invariant: Run is cancelled, getActiveAgentRun returns null
    const activeRun = await getActiveAgentRun(user);
    expect(activeRun).toBeNull();
  });

  it('resumes a time-only correction against the original date and timezone after midnight', async () => {
    const userLA = { ...user, id: 'user-run-anchor-la', phone_number: '573007776656', timezone: 'America/Los_Angeles' };
    const originalReference = new Date('2026-10-02T06:55:00.000Z'); // Oct 1, 23:55 PDT
    await executeTurnIntent({ actions: [{
      domain: 'reminder',
      action: 'create',
      content: 'Same day alerts',
      schedule: { kind: 'relative_day_time', dayOffset: 1 },
      missingFields: ['time'],
    }] }, { user: userLA, language: 'en', timezone: userLA.timezone, referenceTime: originalReference });

    const staged = await getActiveAgentRun(userLA, originalReference);
    expect(staged.context).toMatchObject({ referenceTime: originalReference.toISOString(), timezone: userLA.timezone });
    expect(formatActiveRunPrompt(staged)).toContain('Same day alerts');
    expect(formatActiveRunPrompt(staged)).toContain('relative_day_time');

    const resumedAt = new Date('2026-10-02T07:05:00.000Z'); // Oct 2, 00:05 PDT
    const executeTool = vi.fn().mockResolvedValue({ success: true, action: 'created_reminder', data: { id: 'rem-la-1', content: 'Same day alerts' } });
    const resumed = await executeContinuationDecision({
      run: await getActiveAgentRun(userLA, resumedAt),
      suppliedFields: { schedule: { kind: 'local_time', hour: 7, minute: 0, clockMode: 'explicit_24h' } },
      executionContext: { user: userLA, language: 'en', timezone: userLA.timezone, referenceTime: resumedAt },
      executeTool,
    });

    expect(resumed.results[0].result.data).toBeDefined();
    expect(executeTool.mock.calls[0][0].params.items[0]).toMatchObject({ targetTime: '2026-10-02T14:00:00.000Z' });
  });

  it('uses the current request timezone for a fresh explicit calendar replacement', async () => {
    const userLA = { ...user, id: 'user-run-current-zone', phone_number: '573007776659', timezone: 'America/Los_Angeles' };
    const originalReference = new Date('2026-10-02T06:55:00.000Z');
    await executeTurnIntent({ actions: [{
      domain: 'reminder', action: 'create', content: 'Pending appointment',
      schedule: { kind: 'relative_day_time', dayOffset: 1 }, missingFields: ['time'],
    }] }, { user: userLA, language: 'en', timezone: userLA.timezone, referenceTime: originalReference });
    const pending = await getActiveAgentRun(userLA, originalReference);
    const currentUser = { ...userLA, timezone: 'America/Bogota' };
    const resumedAt = new Date('2026-10-02T07:05:00.000Z');
    const executeTool = vi.fn().mockResolvedValue({ success: true, action: 'created_reminder', data: { id: 'rem-zone', content: 'New appointment' } });

    await executeContinuationDecision({
      run: pending,
      suppliedFields: { schedule: { kind: 'calendar_date_time', year: 2026, month: 10, day: 6, hour: 17, minute: 0, clockMode: 'explicit_24h' }, content: 'New appointment' },
      executionContext: { user: currentUser, language: 'en', timezone: currentUser.timezone, referenceTime: resumedAt },
      executeTool,
    });

    expect(executeTool.mock.calls[0][0].params.items[0].targetTime).toBe('2026-10-06T22:00:00.000Z');
  });

  it('includes the complete canonical pending payload in the continuation prompt', () => {
    const prompt = formatActiveRunPrompt({
      id: 'run-complete-prompt', kind: 'reminder_creation', status: 'waiting_for_input',
      waiting_for: { type: 'missing_fields', fields: ['target'] },
      preparedActions: [{ call_id: 'call-1', domain: 'task', action: 'update', payload: {
        target: 'Task A', scope: 'all', newName: 'Task B', deliveryPolicy: { leadMinutes: 15 },
        context: { reason: 'user-requested' }, missingFields: ['target'],
      } }],
    });

    expect(prompt).toContain('"scope":"all"');
    expect(prompt).toContain('"newName":"Task B"');
    expect(prompt).toContain('"context":{"reason":"user-requested"}');
    expect(prompt).toContain('"deliveryPolicy":{"leadMinutes":15}');
  });

  it('anchors a fresh relative offset to the current resume message, not the original draft time', async () => {
    const userLA = { ...user, id: 'user-run-current-relative-la', phone_number: '573007776657', timezone: 'America/Los_Angeles' };
    const originalReference = new Date('2026-10-02T06:55:00.000Z');
    await executeTurnIntent({ actions: [{
      domain: 'reminder',
      action: 'create',
      content: 'Relative from now',
      missingFields: ['schedule'],
    }] }, { user: userLA, language: 'en', timezone: userLA.timezone, referenceTime: originalReference });

    const resumedAt = new Date('2026-10-02T07:05:00.000Z');
    const executeTool = vi.fn().mockResolvedValue({ success: true, action: 'created_reminder', data: { id: 'rem-now-1', content: 'Relative from now' } });
    const resumed = await executeContinuationDecision({
      run: await getActiveAgentRun(userLA, resumedAt),
      suppliedFields: { schedule: { kind: 'relative_offset', offsetMinutes: 90 } },
      executionContext: { user: userLA, language: 'en', timezone: userLA.timezone, referenceTime: resumedAt },
      executeTool,
    });

    expect(executeTool.mock.calls[0][0].params.items[0].targetTime).toBe('2026-10-02T08:35:00.000Z');
  });

  it('supersedes a pending draft only after a valid replacement is parsed and executes only the replacement', async () => {
    const userLA = { ...user, id: 'user-run-supersede', phone_number: '573007776658', display_name: 'Ana', timezone: 'America/Los_Angeles' };
    const referenceTime = new Date('2026-10-02T06:55:00.000Z'); // Oct 1, 23:55 PDT; stale pending schedule is tomorrow at 07:00
    await executeTurnIntent({ actions: [{
      domain: 'reminder', action: 'create', content: 'Ana appointment reminder',
      schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 7, minute: 0, clockMode: 'explicit_24h' },
      missingFields: ['date'],
    }] }, {
      user: userLA, language: 'en', timezone: userLA.timezone, referenceTime,
    });
    const oldRun = await getActiveAgentRun(userLA, referenceTime);

    callChatCompletion.mockResolvedValueOnce(modelResponse({ relation: 'supersede' }));
    callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [
      { domain: 'reminder', action: 'create', content: 'Ana appointment', schedule: { kind: 'calendar_date_time', year: 2026, month: 10, day: 6, hour: 17, minute: 0, clockMode: 'explicit_24h' } },
      { domain: 'reminder', action: 'create', content: 'Ana appointment morning reminder', schedule: { kind: 'calendar_date_time', year: 2026, month: 10, day: 6, hour: 7, minute: 0, clockMode: 'explicit_24h' } },
      { domain: 'reminder', action: 'create', content: 'Ana appointment afternoon reminder', schedule: { kind: 'calendar_date_time', year: 2026, month: 10, day: 6, hour: 16, minute: 0, clockMode: 'explicit_24h' } },
    ] }));
    executeTool.mockResolvedValue({ success: true, action: 'created_reminder', data: { id: 'rem-corrected', content: 'Corrected appointment' } });

    const result = await routeMessage('Actually, schedule the corrected appointment for Tuesday at 5 pm', userLA, [], { referenceTime });

    expect(result.plan.type).toBe('turn_intent');
    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(executeTool.mock.calls.map(([call]) => call.params.items[0].targetTime)).toEqual([
      '2026-10-07T00:00:00.000Z',
      '2026-10-06T14:00:00.000Z',
      '2026-10-06T23:00:00.000Z',
    ]);
    expect(executeTool.mock.calls.map(([call]) => call.params.items[0].content)).toEqual([
      'Ana appointment', 'Ana appointment morning reminder', 'Ana appointment afternoon reminder',
    ]);
    expect(await getActiveAgentRun(userLA, referenceTime)).toBeNull();
    expect(oldRun.status).toBe('waiting_for_input');
  });

  it('preserves the pending draft when supersede classification is followed by provider failure', async () => {
    const referenceTime = new Date('2026-10-01T16:00:00.000Z');
    await executeTurnIntent({ actions: [{ domain: 'reminder', action: 'create', content: 'Keep me pending', missingFields: ['schedule'] }] }, {
      user, language: 'es', timezone: user.timezone, referenceTime,
    });
    const pending = await getActiveAgentRun(user, referenceTime);

    callChatCompletion.mockResolvedValueOnce(modelResponse({ relation: 'supersede' }));
    callChatCompletion.mockResolvedValueOnce({ content: '', tool_calls: [], unavailable: true });
    const result = await routeMessage('No, mejor crea otra cosa', user, [], { referenceTime });

    expect(result.plan.type).toBe('provider_unavailable');
    expect((await getActiveAgentRun(user, referenceTime)).id).toBe(pending.id);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('preserves the pending draft when a superseding canonical turn is invalid', async () => {
    const referenceTime = new Date('2026-10-01T16:00:00.000Z');
    await executeTurnIntent({ actions: [{ domain: 'reminder', action: 'create', content: 'Keep me pending', missingFields: ['schedule'] }] }, {
      user, language: 'es', timezone: user.timezone, referenceTime,
    });
    const pending = await getActiveAgentRun(user, referenceTime);

    callChatCompletion.mockResolvedValueOnce(modelResponse({ relation: 'supersede' }));
    callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [{ domain: 'reminder', action: 'unknown' }] }));
    const result = await routeMessage('Replace it with an invalid action', user, [], { referenceTime });

    expect(result.plan.type).toBe('invalid_intent');
    expect((await getActiveAgentRun(user, referenceTime)).id).toBe(pending.id);
  });

  it('fails closed when the exact pending run cannot be confirmed cancelled', async () => {
    const referenceTime = new Date('2026-10-01T16:00:00.000Z');
    await executeTurnIntent({ actions: [{ domain: 'reminder', action: 'create', content: 'Do not discard me', missingFields: ['schedule'] }] }, {
      user, language: 'es', timezone: user.timezone, referenceTime,
    });
    const pending = await getActiveAgentRun(user, referenceTime);
    vi.spyOn(agentRunModule, 'cancelSupersededInputRun').mockResolvedValueOnce(false);
    callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', relation: 'supersede' }));
    callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', actions: [{
      domain: 'reminder', action: 'create', content: 'Replacement',
      schedule: { kind: 'calendar_date_time', year: 2026, month: 10, day: 6, hour: 17, minute: 0, clockMode: 'explicit_24h' },
    }] }));

    const result = await routeMessage('Replace that with an appointment on Tuesday at 5 pm', user, [], { referenceTime });

    expect(executeTool).not.toHaveBeenCalled();
    expect((await getActiveAgentRun(user, referenceTime)).id).toBe(pending.id);
    expect(result.confirmation).toContain('I did not run the replacement');
  });

  it('does not execute or claim the old request stayed intact when replacement activation is uncertain', async () => {
    vi.spyOn(agentRunModule, 'createInputRun').mockResolvedValueOnce({
      id: 'staged-inert-replacement',
      status: 'failed',
      activationFailed: true,
      activationStatusUnknown: true,
      preparedActions: [{ payload: { content: 'Replacement draft' } }],
    });
    const result = await executeTurnIntent({ actions: [{
      domain: 'reminder', action: 'create', content: 'Replacement draft', missingFields: ['schedule'],
    }] }, {
      user, language: 'en', timezone: user.timezone, referenceTime: new Date('2026-10-01T16:00:00.000Z'),
      supersedesRunId: 'old-pending-run',
    });

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.records[0].result.error).toContain('may already have been cancelled');
    expect(result.records[0].result.error).not.toContain('left unchanged');
  });

  it('does not stage a second incomplete operation while preserving an unrelated pending draft', async () => {
    const referenceTime = new Date(Date.now() + 1_000);
    await executeTurnIntent({ actions: [{ domain: 'reminder', action: 'create', content: 'Unrelated first', missingFields: ['schedule'] }] }, {
      user, language: 'es', timezone: user.timezone, referenceTime,
    });
    const firstRun = await getActiveAgentRun(user, referenceTime);

    callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', relation: 'unrelated' }));
    callChatCompletion.mockResolvedValueOnce(modelResponse({ responseLanguage: 'en', actions: [{
      domain: 'reminder', action: 'create', content: 'Separate incomplete', missingFields: ['schedule'],
    }] }));
    const result = await routeMessage('Also remind me about a separate thing', user, [], { referenceTime });

    expect((await getActiveAgentRun(user, referenceTime)).id).toBe(firstRun.id);
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.confirmation).toContain('pending request');
  });

  it('executes a complete unrelated turn while leaving the pending draft untouched', async () => {
    const referenceTime = new Date('2026-10-01T16:00:00.000Z');
    await executeTurnIntent({ actions: [{
      domain: 'reminder', action: 'create', content: 'First draft', missingFields: ['schedule'],
    }] }, { user, language: 'es', timezone: user.timezone, referenceTime });
    const pending = await getActiveAgentRun(user, referenceTime);
    callChatCompletion.mockResolvedValueOnce(modelResponse({ relation: 'unrelated' }));
    callChatCompletion.mockResolvedValueOnce(modelResponse({ actions: [{
      domain: 'reminder', action: 'create', content: 'Complete unrelated',
      schedule: { kind: 'calendar_date_time', year: 2026, month: 10, day: 6, hour: 17, minute: 0, clockMode: 'explicit_24h' },
    }] }));
    executeTool.mockResolvedValueOnce({ success: true, action: 'created_reminder', data: { id: 'rem-unrelated', content: 'Complete unrelated' } });

    await routeMessage('Also remind me about a separate complete request', user, [], { referenceTime });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][0].params.items[0].content).toBe('Complete unrelated');
    expect((await getActiveAgentRun(user, referenceTime)).id).toBe(pending.id);
  });

  it('allows only one concurrent replacement write against the same bound pending run', async () => {
    const referenceTime = new Date('2026-10-01T16:00:00.000Z');
    await executeTurnIntent({ actions: [{
      domain: 'reminder', action: 'create', content: 'Concurrent source', missingFields: ['schedule'],
    }] }, { user, language: 'es', timezone: user.timezone, referenceTime });
    const pending = await getActiveAgentRun(user, referenceTime);
    const injectedExecuteTool = vi.fn().mockResolvedValue({ success: true, action: 'created_reminder', data: {} });
    const replacement = (content) => executeTurnIntent({ actions: [{
      domain: 'reminder', action: 'create', content,
      schedule: { kind: 'calendar_date_time', year: 2026, month: 10, day: 6, hour: 17, minute: 0, clockMode: 'explicit_24h' },
    }] }, {
      user, language: 'es', timezone: user.timezone, referenceTime,
      supersedesRunId: pending.id,
      executeTool: injectedExecuteTool,
    });

    const results = await Promise.all([replacement('First replacement'), replacement('Second replacement')]);

    expect(injectedExecuteTool).toHaveBeenCalledTimes(1);
    expect(results.flatMap((result) => result.records).filter(({ result }) => result.errorCode === 'PENDING_REQUEST_CHANGED')).toHaveLength(1);
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
