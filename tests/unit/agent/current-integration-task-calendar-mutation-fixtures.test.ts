import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
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
  supabase: {},
  getDailyOverview: vi.fn().mockResolvedValue(null),
  getUserSubscription: vi.fn().mockResolvedValue({ status: 'authorized', plan: 'pro' }),
  getUserIntegration: vi.fn().mockResolvedValue(null),
  hasProAccess: vi.fn().mockReturnValue(true),
  createPendingSubscription: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/integrations/google/auth.js', () => ({
  getGoogleConnectUrl: vi.fn(() => 'https://example.test/google'),
  hasUsableGoogleCredentials: vi.fn(() => false),
}));


import { afterEach } from 'vitest';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { matchesSchema } from '../../../src/agent/contracts/schema-value-contract.js';
import { validateForegroundContent } from '../../../src/agent/contracts/foreground-turn-validator.js';
import { routeMessage } from '../../../src/agent/orchestration/router.js';
import { callChatCompletion } from '../../../src/agent/providers/client.js';
import { executeTool } from '../../../src/agent/tools/index.js';
import { clearWorkingMemory, getWorkingMemory, saveWorkingMemory } from '../../../src/agent/core/working-memory.js';

import { finalSafetyActions, finalSafetyMessage } from '../../fixtures/agent/behavioral-final-safety-fixtures.js';
import { taskCalendarMutationActions, taskCalendarMutationMessage } from '../../fixtures/agent/behavioral-task-calendar-mutation-fixtures.js';
import { createTaskCompleteTool } from '../../../src/agent/tools/task-complete-tool.js';
import { createTaskTargetResolution } from '../../../src/agent/tools/task-target-resolution.js';
import { createCalendarTool } from '../../../src/agent/tools/calendar-tool.js';
import { parseStructuredOrdinal, resolveContextReference } from '../../../src/agent/core/context-reference.js';
import { isStrictUUID, normalizeTextForMatching, calculateMatchScore } from '../../../src/shared/entity-resolution.js';
import { selectEntityCandidate } from '../../../src/infrastructure/database/entities.js';
import type { FeatureQuery, FeatureRow } from '../../../src/features/read-model-ports.js';
import * as time from '../../../src/shared/time.js';
import { formatRecurrenceLabel } from '../../../src/shared/reminder-presentation.js';

const user = { id: 'mutation-owner', phone_number: '573990001122', timezone: 'America/Bogota', locale: 'es-CO' };
const referenceTime = new Date('2026-09-02T17:00:00Z');
beforeEach(() => { vi.clearAllMocks(); clearWorkingMemory(user); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(referenceTime); });
afterEach(() => { vi.useRealTimers(); clearWorkingMemory(user); });
function plan(key: keyof typeof taskCalendarMutationActions) {
  untrustedResultMock(callChatCompletion).mockResolvedValueOnce(taskCalendarMutationMessage(key));
}
function taskFixture() {
  const rows: FeatureRow[] = [
    { id: '11111111-1111-4111-8111-111111111111', user_id: user.id, status: 'pending', title: taskCalendarMutationActions.completeNamed.target },
    { id: '22222222-2222-4222-8222-222222222222', user_id: user.id, status: 'pending', title: 'Actualizar contrato con proveedor' },
  ];
  const resolver = createTaskTargetResolution({
    supabase: { from(table) {
      let data = table === 'tasks' ? [...rows] : [];
      const query: FeatureQuery = {
        select: () => query, eq: (column, value) => { data = data.filter(row => row[column] === value); return query; },
        in: (column, values) => { data = data.filter(row => values.includes(String(row[column]))); return query; },
        or: () => query, gte: () => query, lt: () => query, lte: () => query, like: () => query, order: () => query, limit: () => query,
        maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
        then: (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject),
      }; return query;
    } }, getWorkingMemory: ((key: unknown) => getWorkingMemory(key as Parameters<typeof getWorkingMemory>[0])) as unknown as Parameters<typeof createTaskTargetResolution>[0]['getWorkingMemory'],
    parseStructuredOrdinal,
    resolveContextReference: resolveContextReference as unknown as Parameters<typeof createTaskTargetResolution>[0]['resolveContextReference'],
    isStrictUUID, normalizeTextForMatching, calculateMatchScore, selectEntityCandidate: selectEntityCandidate as unknown as Parameters<typeof createTaskTargetResolution>[0]['selectEntityCandidate'], logger: console, getNowMs: () => Date.now(),
  });
  const updateTask = vi.fn(async (id: string, patch: Record<string, unknown>, owner: string | undefined) => {
    const row = rows.find(row => row.id === id && row.user_id === owner);
    if (!row) return null;
    Object.assign(row, patch); return row;
  });
  const acknowledgeRemindersByTaskId = vi.fn(async () => null);
  const tool = createTaskCompleteTool({ ...resolver, updateTask, acknowledgeRemindersByTaskId,
    completeTasksByQuery: vi.fn(async () => null), logger: console, getNowMs: () => Date.now() });
  untrustedResultMock(executeTool).mockImplementation(async call => {
    if (!call || typeof call !== 'object') throw new Error('Expected domain call');
    if (call.params?.action === 'list') return { success: true, action: 'listed_tasks', data: { tasks: rows.map(row => ({ ...row })) } };
    return tool.executeTaskComplete({ params: call.params || {}, user, language: call.language || 'es' });
  });
  return { rows, updateTask, acknowledgeRemindersByTaskId, tool };
}
function calendarFixture() {
  const saveCompanion = vi.fn(async () => ({ id: 'gcal-companion' }));
  const createCalendarEvent = vi.fn(async () => ({ id: 'gcal-event-12345', summary: 'Reunión de trabajo' }));
  const deps: Parameters<typeof createCalendarTool>[0] = {
    getUserIntegration: vi.fn(async () => ({ account_email: 'fixture@example.test' })),
    hasUsableGoogleCredentials: () => true, isGoogleAuthError: () => false,
    saveReminder: saveCompanion,
    cancelCalendarCompanionReminders: vi.fn(async () => ({ cancelled: 0 })),
    rescheduleCalendarCompanionReminders: vi.fn(async () => ({ rescheduled: 0 })),
    getGoogleConnectUrl: () => 'https://example.test/google', revokeGoogleIntegration: vi.fn(async () => null),
    listCalendarEvents: vi.fn(async () => []), createCalendarEvent,
    updateCalendarEvent: vi.fn(async () => ({ id: 'updated' })), deleteCalendarEvent: vi.fn(async () => null),
    parseTargetTime: time.parseTargetTime, getDayBounds: time.getDayBounds,
    resolveCalendarTemporalScope: time.resolveCalendarTemporalScope, formatLocalDateTime: time.formatLocalDateTime,
    formatHumanFriendlyDateTime: time.formatHumanFriendlyDateTime, formatHumanFriendlyDate: time.formatHumanFriendlyDate,
    zonedTimeToUtc: time.zonedTimeToUtc, DEFAULT_TIMEZONE: 'America/Bogota', formatRecurrenceLabel,
    parseStructuredOrdinal, resolveContextReference, getWorkingMemory: key => getWorkingMemory(key as Parameters<typeof getWorkingMemory>[0]),
    getNow: () => referenceTime, getNowMs: () => referenceTime.getTime(), logger: console,
  };
  return { ...createCalendarTool(deps), deps };
}


describe('current task completion and ordinal Calendar deletion fixtures', () => {
  it.each(Object.keys(taskCalendarMutationActions) as (keyof typeof taskCalendarMutationActions)[])('%s uses strict current foreground wire', key => {
    const message = taskCalendarMutationMessage(key);
    expect(matchesSchema(JSON.parse(message.content), getStructuredTurnSchema() as Parameters<typeof matchesSchema>[1])).toBe(true);
    expect(validateForegroundContent(message.content).valid).toBe(true);
  });

  it('completes the named task through the actual resolver and completion adapter without changing its neighbor', async () => {
    const f = taskFixture(); plan('completeNamed');
    const result = await routeMessage(`${f.rows[0]!.title}: Ya lo hice`, user, [], { referenceTime });
    expect(result.confirmation).toContain('Tarea completada');
    expect(result.confirmation).toContain(f.rows[0]!.title);
    expect(result.confirmation).not.toContain(f.rows[1]!.title);
    expect(f.rows.map(row => row.status)).toEqual(['completed', 'pending']);
    expect(f.updateTask).toHaveBeenCalledExactlyOnceWith(f.rows[0]!.id, { status: 'completed' }, user.id);
    expect(f.acknowledgeRemindersByTaskId).toHaveBeenCalledExactlyOnceWith(f.rows[0]!.id, user.id);
  });

  it('completes the second displayed task and acknowledges only its linked reminders', async () => {
    const f = taskFixture(); plan('listTasks');
    const first = await routeMessage('¿Cuáles son mis tareas?', user, [], { referenceTime });
    expect(getWorkingMemory(user)?.items.map(item => item.internalId)).toEqual(f.rows.map(row => row.id));
    plan('completeSecond');
    const result = await routeMessage('La segunda ya la hice', user, [{ role: 'assistant', content: first.confirmation }], { referenceTime });
    expect(f.rows.map(row => row.status)).toEqual(['pending', 'completed']);
    expect(result.confirmation).toContain(f.rows[1]!.title);
    expect(result.confirmation).not.toContain(f.rows[0]!.title);
    expect(f.updateTask).toHaveBeenCalledExactlyOnceWith(f.rows[1]!.id, { status: 'completed' }, user.id);
    expect(f.acknowledgeRemindersByTaskId).toHaveBeenCalledExactlyOnceWith(f.rows[1]!.id, user.id);
  });

  it('rejects an absent second displayed task without executing a mutation', async () => {
    const f = taskFixture(); plan('completeSecond');
    await routeMessage('La segunda ya la hice', user, [], { referenceTime });
    expect(executeTool).not.toHaveBeenCalled();
    expect(f.updateTask).not.toHaveBeenCalled();
    expect(f.acknowledgeRemindersByTaskId).not.toHaveBeenCalled();
    expect(f.rows.map(row => row.status)).toEqual(['pending', 'pending']);
  });

  it('rechecks task ownership after a displayed list before completing its bound identity', async () => {
    const f = taskFixture(); plan('listTasks');
    await routeMessage('¿Cuáles son mis tareas?', user, [], { referenceTime });
    f.rows[1]!.user_id = 'other-owner';
    plan('completeSecond');
    const result = await routeMessage('La segunda ya la hice', user, [], { referenceTime });
    expect(result.confirmation).not.toContain('Tarea completada');
    expect(f.updateTask).not.toHaveBeenCalled();
    expect(f.acknowledgeRemindersByTaskId).not.toHaveBeenCalled();
    expect(f.rows.map(row => row.status)).toEqual(['pending', 'pending']);
  });

  it('deletes the second displayed Friday event using its opaque ID and cleans only that event companions', async () => {
    const f = calendarFixture();
    const events = [
      { id: 'ev-fri-a', summary: 'Standup Viernes', start: { dateTime: '2026-09-04T09:00:00-05:00' }, end: { dateTime: '2026-09-04T09:30:00-05:00' } },
      { id: 'ev-fri-b', summary: 'Demostración de Producto', start: { dateTime: '2026-09-04T15:00:00-05:00' }, end: { dateTime: '2026-09-04T16:00:00-05:00' } },
    ];
    vi.mocked(f.deps.listCalendarEvents).mockImplementation(async (_owner, options) => options?.q ? [] : events);
    vi.mocked(f.deps.deleteCalendarEvent).mockResolvedValue(true);
    untrustedResultMock(executeTool).mockImplementation(async call => {
      if (!call || typeof call !== 'object') throw new Error('Expected domain call');
      return f.executeCalendarTool({ action: String(call.params?.action), params: call.params || {}, user, language: call.language || 'es', referenceTime });
    });
    plan('fridayCalendar');
    const first = await routeMessage('¿Qué reuniones tenemos el viernes?', user, [], { referenceTime });
    expect(first.confirmation).toContain('Standup Viernes');
    expect(first.confirmation).toContain('Demostración de Producto');
    expect(getWorkingMemory(user)?.items.map(item => item.internalId)).toEqual(events.map(event => event.id));
    expect(f.deps.listCalendarEvents).toHaveBeenCalledWith(user.id, expect.objectContaining({ timeMin: new Date('2026-09-04T05:00:00Z'), timeMax: new Date('2026-09-05T05:00:00Z') }));
    plan('deleteSecond');
    const result = await routeMessage('Cancela la segunda', user, [{ role: 'assistant', content: first.confirmation }], { referenceTime });
    expect(f.deps.deleteCalendarEvent).toHaveBeenCalledExactlyOnceWith(user.id, 'ev-fri-b');
    expect(f.deps.cancelCalendarCompanionReminders).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: user.id, eventId: 'ev-fri-b' }));
    expect(result.confirmation).toContain('eliminado');
    expect(result.confirmation).toContain('Demostración de Producto');
    expect(result.confirmation).not.toContain('Standup Viernes');
    expect(f.deps.createCalendarEvent).not.toHaveBeenCalled();
    expect(f.deps.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it.each(Object.keys(finalSafetyActions) as (keyof typeof finalSafetyActions)[])('%s validates the final safety protocol', key => {
    const message = finalSafetyMessage(key);
    expect(matchesSchema(JSON.parse(message.content), getStructuredTurnSchema() as Parameters<typeof matchesSchema>[1])).toBe(true);
    expect(validateForegroundContent(message.content).valid).toBe(true);
  });

  it('clarifies two matching task titles without updating or acknowledging either task', async () => {
    const f = taskFixture();
    f.rows[0]!.title = 'Reporte financiero Q3 para inversionistas';
    f.rows[1]!.title = 'Reporte financiero Q3 para la junta directiva';
    untrustedResultMock(callChatCompletion).mockResolvedValueOnce(finalSafetyMessage('ambiguousTask'));
    const result = await routeMessage('Ya terminé el reporte financiero Q3', user, [], { referenceTime });
    expect(result.confirmation).toContain('coinciden');
    expect(result.confirmation).toContain(f.rows[0]!.title);
    expect(result.confirmation).toContain(f.rows[1]!.title);
    expect(result.executionFacts?.[0]?.errorCode).toBe('AMBIGUOUS_TARGET');
    expect(f.updateTask).not.toHaveBeenCalled();
    expect(f.acknowledgeRemindersByTaskId).not.toHaveBeenCalled();
    expect(f.rows.map(row => row.status)).toEqual(['pending', 'pending']);
  });

  it('reads the explicit empty Calendar day without presenting or mutating the old displayed event', async () => {
    const f = calendarFixture();
    saveWorkingMemory(user, { source: 'calendar', scope: 'today', items: [{ position: 1, type: 'calendar_event', internalId: 'ev-old', summary: 'Reunión Antigua' }] });
    untrustedResultMock(executeTool).mockImplementation(async call => {
      if (!call || typeof call !== 'object') throw new Error('Expected domain call');
      return f.executeCalendarTool({ action: String(call.params?.action), params: call.params || {}, user, language: call.language || 'es', referenceTime });
    });
    untrustedResultMock(callChatCompletion).mockResolvedValueOnce(finalSafetyMessage('datedEmptyCalendar'));
    const result = await routeMessage('¿Qué tengo el 15 de septiembre?', user, [], { referenceTime });
    expect(result.confirmation).toContain('No tienes eventos programados');
    expect(result.confirmation).not.toContain('Reunión Antigua');
    expect(f.deps.listCalendarEvents).toHaveBeenCalledExactlyOnceWith(user.id, expect.objectContaining({ timeMin: new Date('2026-09-15T05:00:00Z'), timeMax: new Date('2026-09-16T05:00:00Z') }));
    expect(f.deps.deleteCalendarEvent).not.toHaveBeenCalled();
    expect(f.deps.updateCalendarEvent).not.toHaveBeenCalled();
    expect(f.deps.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('rejects a foreign task even when its ID is injected into displayed context', async () => {
    const f = taskFixture(); f.rows[0]!.user_id = 'other-owner';
    saveWorkingMemory(user, { source: 'task', items: [{ type: 'task', internalId: f.rows[0]!.id, summary: 'Tarea ajena' }] });
    untrustedResultMock(callChatCompletion).mockResolvedValueOnce(finalSafetyMessage('completeDisplayed'));
    const result = await routeMessage('Completa la primera tarea', user, [], { referenceTime });
    expect(result.executionFacts?.[0]?.errorCode).toBe('NOT_FOUND');
    expect(result.confirmation).not.toContain('Tarea completada');
    expect(f.updateTask).not.toHaveBeenCalled();
    expect(f.acknowledgeRemindersByTaskId).not.toHaveBeenCalled();
    expect(f.rows[0]!.status).toBe('pending');
  });

  it.each(['es', 'en'] as const)('confirms an already completed owned task in %s without repeated effects', async language => {
    const f = taskFixture(); f.rows[0]!.status = 'completed';
    saveWorkingMemory(user, { source: 'task', items: [{ type: 'task', internalId: f.rows[0]!.id, summary: f.rows[0]!.title }] });
    untrustedResultMock(callChatCompletion).mockResolvedValueOnce(finalSafetyMessage('completeDisplayed', language));
    const result = await routeMessage(language === 'es' ? 'Ya lo hice' : 'Already done', user, [], { referenceTime });
    expect(result.confirmation).toContain(language === 'es' ? 'Tarea ya completada' : 'Task already completed');
    expect(result.confirmation).toContain(f.rows[0]!.title);
    expect(result.executionFacts?.[0]?.success).toBe(true);
    expect(f.updateTask).not.toHaveBeenCalled();
    expect(f.acknowledgeRemindersByTaskId).not.toHaveBeenCalled();
    expect(f.rows.map(row => row.status)).toEqual(['completed', 'pending']);
  });

  it('does not report a foreign completed task as an idempotent success', async () => {
    const f = taskFixture(); f.rows[0]!.status = 'completed'; f.rows[0]!.user_id = 'other-owner';
    const result = await f.tool.executeTaskComplete({ params: { target: f.rows[0]!.id }, user });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
    expect(f.updateTask).not.toHaveBeenCalled();
    expect(f.acknowledgeRemindersByTaskId).not.toHaveBeenCalled();
  });

});
