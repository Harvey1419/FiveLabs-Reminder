import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/agent/tools/index.js', () => ({
  executeTool: vi.fn(),
}));

import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import { executeTool as defaultExecuteTool } from '../../../src/agent/tools/index.js';
import {
  createInputRun,
  executeContinuationDecision as continueRun,
} from '../../../src/agent/core/agent-run.js';
import * as agentRunStorage from '../../../src/infrastructure/database/agent-runs.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';
import type { LegacyDomainExecutionCall } from '../../../src/agent/core/agent-run.js';
// Results expose only the fields inspected here; no runtime result is transformed.
function executeContinuationDecision(...args: Parameters<typeof continueRun>) {
  return continueRun(...args) as ReturnType<typeof continueRun> & Promise<{
    facts: { success: boolean; presentationParams: unknown }[];
    results: { result: { outcome?: string } }[];
  }>;
}


const user = {
  id: 'usr-domain-parity',
  phone_number: '573001112233',
  timezone: 'America/Bogota',
  locale: 'en-CO',
};

const referenceTime = new Date('2026-10-01T12:00:00.000Z');

const cases = [
  {
    name: 'task creation with a due date',
    action: {
      domain: 'task',
      action: 'create',
      title: 'Submit invoice',
      description: 'October invoice',
      priority: 'high',
      projectless: true,
      schedule: { kind: 'calendar_date_time', year: 2026, month: 10, day: 4, hour: 9, minute: 30, clockMode: 'explicit_24h' },
    },
    expected: {
      toolName: 'manage_task',
      params: { action: 'create', items: [{ title: 'Submit invoice', description: 'October invoice', priority: 'high', dueDate: '2026-10-04T14:30:00.000Z' }] },
    },
  },
  {
    name: 'reminder creation with delivery policy',
    action: {
      domain: 'reminder',
      action: 'create',
      content: 'Call the clinic',
      schedule: { kind: 'relative_day_time', dayOffset: 2, hour: 10, minute: 15, clockMode: 'explicit_24h' },
      deliveryPolicy: { advanceNotice: 'offset', advanceMinutes: 20 },
    },
    expected: {
      toolName: 'manage_reminder',
      params: { action: 'create', items: [{ content: 'Call the clinic', targetTime: '2026-10-03T15:15:00.000Z', advanceMinutes: 20 }] },
    },
  },
  {
    name: 'calendar creation with typed schedule and duration',
    action: {
      domain: 'calendar',
      action: 'create',
      title: 'Project review',
      schedule: { kind: 'calendar_date_time', year: 2026, month: 10, day: 5, hour: 14, minute: 0, clockMode: 'explicit_24h' },
      durationMinutes: 45,
      addGoogleMeet: true,
    },
    expected: {
      toolName: 'manage_google_calendar',
      params: { action: 'create_event', startDateTime: '2026-10-05T19:00:00.000Z', summary: 'Project review', durationMinutes: 45, addGoogleMeet: true },
    },
  },
];

function successResult() {
  return { success: true, action: 'created', data: {}, rawSummary: 'Created.' };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  agentRunStorage.resetInMemoryAgentRuns();
  untrustedResultMock(defaultExecuteTool).mockResolvedValue(successResult());
});

describe('fresh and resumed domain-call parity', () => {
  it.each(cases)('uses the same tool and canonical parameters for $name', async ({ action, expected }) => {
    const freshExecutor = vi.fn<NonNullable<NonNullable<Parameters<typeof executeTurnIntent>[1]>['executeTool']>>().mockResolvedValue(successResult());
    await executeTurnIntent({ actions: [action] }, {
      user,
      language: 'en',
      isPro: true,
      timezone: user.timezone,
      referenceTime,
      executeTool: freshExecutor,
    });
    expect(freshExecutor).toHaveBeenCalledTimes(1);
    const [freshCall] = freshExecutor.mock.calls[0]!;
    expect({ toolName: freshCall!.toolName, params: freshCall!.params }).toEqual(expected);

    const run = await createInputRun({
      user,
      partialAction: { ...action, missingFields: ['resume'] },
      missingFields: ['resume'],
      question: 'Provide the missing detail.',
      referenceTime,
    });
    const resumedExecutor = vi.fn<(call: LegacyDomainExecutionCall) => Promise<ReturnType<typeof successResult>>>().mockResolvedValue(successResult());
    await executeContinuationDecision({
      run: run!,
      suppliedFields: {},
      executionContext: {
        user,
        language: 'en',
        isPro: true,
        timezone: user.timezone,
        referenceTime,
      },
      executeTool: resumedExecutor,
    });

    expect(defaultExecuteTool).not.toHaveBeenCalled();
    expect(resumedExecutor).toHaveBeenCalledTimes(1);
    const [resumedCall] = resumedExecutor.mock.calls[0]!;
    expect({ toolName: resumedCall!.toolName, params: resumedCall!.params })
      .toEqual({ toolName: freshCall!.toolName, params: freshCall!.params });
  });

  it('rejects an unknown resumed domain without choosing a default tool', async () => {
    const run = await createInputRun({
      user,
      partialAction: { domain: 'unknown-domain', action: 'create', content: 'Do not guess' },
      missingFields: ['content'],
      question: 'Provide details.',
      referenceTime,
    });
    const injectedExecutor = vi.fn<(call: LegacyDomainExecutionCall) => Promise<ReturnType<typeof successResult>>>();

    const result = await executeContinuationDecision({
      run: run!,
      suppliedFields: {},
      executionContext: { user, referenceTime, timezone: user.timezone },
      executeTool: injectedExecutor,
    });

    expect(result.success).toBe(false);
    expect(injectedExecutor).not.toHaveBeenCalled();
    expect(defaultExecuteTool).not.toHaveBeenCalled();
  });

  it('persists each observed action before the next write and never replays after an unknown outcome', async () => {
    const run = await createInputRun({
      user,
      partialActions: [
        { domain: 'task', action: 'create', title: 'First task', projectless: true },
        { domain: 'reminder', action: 'create', content: 'Second action', schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 10, minute: 0, clockMode: 'explicit_24h' } },
        { domain: 'calendar', action: 'create', title: 'Must not run', schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 11, minute: 0, clockMode: 'explicit_24h' } },
      ],
      missingFields: ['resume'],
      question: 'Provide the missing detail.',
      referenceTime,
    });
    const injectedExecutor = vi.fn<(call: LegacyDomainExecutionCall) => Promise<ReturnType<typeof successResult>>>()
      .mockResolvedValueOnce(successResult())
      .mockRejectedValueOnce(new Error('The remote outcome timed out.'));

    const firstAttempt = await executeContinuationDecision({
      run: run!,
      suppliedFields: {},
      executionContext: { user, language: 'en', timezone: user.timezone, referenceTime },
      executeTool: injectedExecutor,
    });

    expect(firstAttempt.success).toBe(false);
    expect(firstAttempt.facts).toHaveLength(2);
    expect(firstAttempt.facts[0]!.success).toBe(true);
    expect(firstAttempt.facts[1]!.success).toBe(false);
    expect(injectedExecutor).toHaveBeenCalledTimes(2);
    const storedActions = await agentRunStorage.getPreparedActionsFromDb(run!.id);
    expect(storedActions.map(({ status }) => status)).toEqual(['executed', 'failed', 'prepared']);
    expect(storedActions[1]!.execution_fact).toMatchObject({
      outcome: 'unknown',
      errorCode: 'UNKNOWN_WRITE_OUTCOME',
    });

    const replayAttempt = await executeContinuationDecision({
      run: run!,
      suppliedFields: {},
      executionContext: { user, language: 'en', timezone: user.timezone, referenceTime },
      executeTool: injectedExecutor,
    });

    expect(replayAttempt.success).toBe(false);
    expect(injectedExecutor).toHaveBeenCalledTimes(2);
  });

  it('fences a write before execution so a post-write persistence failure cannot replay after restart', async () => {
    const action = {
      domain: 'reminder',
      action: 'create',
      content: 'Submit the signed form',
      schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 9, minute: 0, clockMode: 'explicit_24h' },
    };
    const run = await createInputRun({
      user,
      partialAction: { ...action, missingFields: ['resume'] },
      missingFields: ['resume'],
      question: 'Provide the missing detail.',
      referenceTime,
    });
    const injectedExecutor = vi.fn<(call: LegacyDomainExecutionCall) => Promise<ReturnType<typeof successResult>>>().mockResolvedValue(successResult());
    const persistPreparedAction = agentRunStorage.updatePreparedActionInDb;
    const updatePreparedAction = vi.spyOn(agentRunStorage, 'updatePreparedActionInDb');
    updatePreparedAction.mockImplementation(async (runId, callId, update) => {
      if (update!.status === 'executed') throw new Error('Injected persistence failure after external success.');
      return persistPreparedAction(runId, callId, update);
    });

    await expect(executeContinuationDecision({
      run: run!,
      suppliedFields: {},
      executionContext: { user, language: 'en', timezone: user.timezone, referenceTime },
      executeTool: injectedExecutor,
    })).rejects.toThrow('Injected persistence failure after external success.');

    expect(injectedExecutor).toHaveBeenCalledTimes(1);
    const storedBeforeRestart = await agentRunStorage.getPreparedActionsFromDb(run!.id);
    expect(storedBeforeRestart[0]).toMatchObject({
      status: 'failed',
      execution_fact: {
        outcome: 'unknown',
        errorCode: 'WRITE_OUTCOME_UNKNOWN',
        _domainCall: { toolName: 'manage_reminder' },
      },
    });

    const resumedAfterRestart = await executeContinuationDecision({
      run: { ...run!, preparedActions: undefined } as Parameters<typeof continueRun>[0]['run'],
      suppliedFields: {},
      executionContext: { user, language: 'en', timezone: user.timezone, referenceTime: new Date('2026-10-08T12:00:00.000Z') },
      executeTool: injectedExecutor,
    });

    expect(injectedExecutor).toHaveBeenCalledTimes(1);
    expect(resumedAfterRestart.success).toBe(false);
    expect(resumedAfterRestart.results[0]!.result.outcome).toBe('unknown');
    expect(resumedAfterRestart.facts[0]!.presentationParams).toEqual(
      (storedBeforeRestart[0]!.execution_fact!._domainCall as { params: unknown }).params,
    );
    updatePreparedAction.mockRestore();
  });

  it('does not call the executor when it cannot persist the pre-write fence', async () => {
    const run = await createInputRun({
      user,
      partialAction: { domain: 'task', action: 'create', title: 'Must remain uncreated', projectless: true },
      missingFields: ['resume'],
      question: 'Provide the missing detail.',
      referenceTime,
    });
    const injectedExecutor = vi.fn<(call: LegacyDomainExecutionCall) => Promise<ReturnType<typeof successResult>>>().mockResolvedValue(successResult());
    const persistPreparedAction = agentRunStorage.updatePreparedActionInDb;
    vi.spyOn(agentRunStorage, 'updatePreparedActionInDb').mockImplementation(async (runId, callId, update) => {
      if (update!.executionFact?.errorCode === 'WRITE_OUTCOME_UNKNOWN') {
        throw new Error('Injected pre-write fence persistence failure.');
      }
      return persistPreparedAction(runId, callId, update);
    });

    await expect(executeContinuationDecision({
      run: run!,
      suppliedFields: {},
      executionContext: { user, language: 'en', timezone: user.timezone, referenceTime },
      executeTool: injectedExecutor,
    })).rejects.toThrow('Injected pre-write fence persistence failure.');

    expect(injectedExecutor).not.toHaveBeenCalled();
    const [storedAction] = await agentRunStorage.getPreparedActionsFromDb(run!.id);
    expect(storedAction!.status).toBe('prepared');
  });
});
