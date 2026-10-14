import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCalendarTools, createTaskTools, ToolRegistry } from '@templelabs/tools';
import { MockAIProvider } from '@templelabs/ai';
import { ProductivityTurnRunner, type ProductivityExecutionJournal } from '@templelabs/agent-core';
import type { AIResponse, ToolCall, TurnContext } from '@templelabs/contracts';
import { createLegacyTaskPort } from '../../../src/adapters/agent-core/legacy-tasks.js';
import { createLegacyCalendarPort } from '../../../src/adapters/agent-core/legacy-calendar.js';

const database = vi.hoisted(() => ({
  from: vi.fn(), createTasksBatch: vi.fn(), inspectOwnedEntityReferences: vi.fn(),
  updateTask: vi.fn(), deleteTask: vi.fn(), saveReminder: vi.fn(),
  acknowledgeRemindersByTaskId: vi.fn(), cancelRemindersByTaskId: vi.fn(),
  getUserIntegration: vi.fn(),
}));
const google = vi.hoisted(() => ({ listCalendarEvents: vi.fn(), createCalendarEvent: vi.fn() }));
vi.mock('../../../src/infrastructure/database/index.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), ...database, supabase: { from: database.from },
}));
vi.mock('../../../src/integrations/google/calendar.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), ...google,
}));
vi.mock('../../../src/integrations/google/auth.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  hasUsableGoogleCredentials: (integration: unknown) => integration !== null,
  getGoogleConnectUrl: () => 'https://example.test/oauth',
}));
vi.mock('../../../src/infrastructure/database/memories.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), getReminderConfirmationPreference: vi.fn().mockResolvedValue(null),
}));

const id = '11111111-1111-4111-8111-111111111111';
const user = { id: 'fixture-owner', phone_number: '+573000000001', timezone: 'America/Bogota' };
const row = { id, user_id: user.id, title: 'Enviar propuesta', status: 'pending', priority: 'high', due_date: '2026-10-11T21:00:00Z', description: 'Borrador' };
const context: TurnContext = {
  userId: user.id, runId: 'fixture-run', requestId: 'fixture-request', language: 'es',
  timezone: user.timezone, referenceTimeIso: '2026-10-11T17:49:00Z', signal: new AbortController().signal,
  capabilities: new Set(['tasks.create', 'tasks.read', 'tasks.update', 'tasks.complete', 'tasks.delete', 'calendar.create', 'calendar.read', 'calendar.connect']),
};
function makeQuery() {
  const query = {
    select: vi.fn(), eq: vi.fn(), gte: vi.fn(), lt: vi.fn(), order: vi.fn(), limit: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
    then: (resolve: (value: { data: typeof row[]; error: null }) => unknown) => Promise.resolve(resolve({ data: [row], error: null })),
  };
  for (const method of [query.select, query.eq, query.gte, query.lt, query.order, query.limit]) method.mockReturnValue(query);
  return query;
}
let query = makeQuery();
function registry() {
  return new ToolRegistry([...createTaskTools(createLegacyTaskPort(user)), ...createCalendarTools(createLegacyCalendarPort(user))]);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2050-01-01T12:00:00Z'));
  query = makeQuery(); database.from.mockReturnValue(query);
  database.inspectOwnedEntityReferences.mockResolvedValue({ success: true, resolutions: [] });
  database.createTasksBatch.mockResolvedValue({ data: [row] });
  database.updateTask.mockImplementation(async (_id: string, changes: Record<string, unknown>) => ({ ...row, ...changes }));
  database.deleteTask.mockResolvedValue({ success: true });
  database.cancelRemindersByTaskId.mockResolvedValue({ cancelled: 1 });
  database.acknowledgeRemindersByTaskId.mockResolvedValue({ acknowledged: 1 });
  database.getUserIntegration.mockResolvedValue({ provider: 'google' });
  database.saveReminder.mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222' });
  google.listCalendarEvents.mockResolvedValue([]);
  google.createCalendarEvent.mockResolvedValue({ id: 'fixture-event', summary: 'Reunión', start: '2026-10-11T21:00:00Z', end: '2026-10-11T22:00:00Z', isAllDay: false });
});
afterEach(() => vi.useRealTimers());

describe('task and calendar adapters through current executors', () => {
  it('creates one task through the canonical atomic batch API', async () => {
    const outcome = await registry().execute('task_create', { title: row.title, priority: 'high', dueDateIso: row.due_date, scheduleReminder: false }, context, 'op');
    expect(outcome).toMatchObject({ status: 'success', receipt: { resourceIds: [id] } });
    expect(database.createTasksBatch).toHaveBeenCalledExactlyOnceWith({ userId: user.id, items: [expect.objectContaining({ title: row.title, dueDate: '2026-10-11T21:00:00.000Z', priority: 'high', scheduleReminder: false })] });
    expect(database.saveReminder).not.toHaveBeenCalled();
  });

  it('checks task ownership before an update and never mutates a foreign row', async () => {
    query.maybeSingle.mockResolvedValueOnce({ data: { ...row, user_id: 'foreign-user' }, error: null });
    expect(await registry().execute('task_update', { taskId: id, title: 'Cambio' }, context, 'op')).toMatchObject({ status: 'failed', code: 'NOT_FOUND' });
    expect(database.updateTask).not.toHaveBeenCalled();
  });

  it('clears due date and preserves partial reminder cancellation effects', async () => {
    database.cancelRemindersByTaskId.mockResolvedValueOnce({ error: { code: 'DATABASE_ERROR' } });
    expect(await registry().execute('task_update', { taskId: id, dueDateIso: null }, context, 'op')).toMatchObject({ status: 'partial', data: { records: [{ id, dueDateIso: null }] } });
    expect(database.updateTask).toHaveBeenCalledExactlyOnceWith(id, { due_date: null }, user.id);
    expect(database.cancelRemindersByTaskId).toHaveBeenCalledExactlyOnceWith(id, user.id);
  });

  it('completes the exact owned task and acknowledges its linked reminders', async () => {
    expect(await registry().execute('task_complete', { taskId: id }, context, 'op')).toMatchObject({ status: 'success', data: { records: [{ status: 'completed' }] } });
    expect(database.updateTask).toHaveBeenCalledWith(id, expect.objectContaining({ status: 'completed' }), user.id);
    expect(database.acknowledgeRemindersByTaskId).toHaveBeenCalledExactlyOnceWith(id, user.id);
  });

  it('retains deletion evidence when linked reminder cleanup fails', async () => {
    database.cancelRemindersByTaskId.mockRejectedValueOnce(new Error('mock cleanup failure'));
    expect(await registry().execute('task_delete', { taskId: id }, context, 'op')).toMatchObject({ status: 'partial', receipt: { resourceIds: [id] }, data: { records: [{ status: 'deleted' }] } });
    expect(database.deleteTask).toHaveBeenCalledExactlyOnceWith(id, user.id);
  });

  it('anchors task today queries to the turn while server clock is in another year', async () => {
    expect((await registry().execute('task_read', { scope: 'today' }, context, 'op')).status).toBe('success');
    expect(query.eq).toHaveBeenCalledWith('user_id', user.id);
    expect(query.gte).toHaveBeenCalledWith('due_date', '2026-10-11T17:49:00.000Z');
    expect(query.lt).toHaveBeenCalledWith('due_date', '2026-10-12T05:00:00.000Z');
    expect(query.limit).toHaveBeenCalledWith(50);
  });

  it('anchors calendar today reads to the turn and authenticated calendar', async () => {
    expect((await registry().execute('calendar_read', { scope: 'today' }, context, 'op')).status).toBe('success');
    expect(google.listCalendarEvents).toHaveBeenCalledExactlyOnceWith(user.id, expect.objectContaining({
      timeMin: new Date(context.referenceTimeIso), timeMax: new Date('2026-10-12T05:00:00Z'), timezone: user.timezone,
    }));
  });

  it('keeps the next-event query at the supplied reference instant', async () => {
    expect((await registry().execute('calendar_read', { scope: 'next_event' }, context, 'op')).status).toBe('success');
    expect(google.listCalendarEvents).toHaveBeenCalledExactlyOnceWith(user.id, expect.objectContaining({
      timeMin: new Date(context.referenceTimeIso), timeMax: null, maxResults: 1,
    }));
  });

  it('creates a timed event through the current Google adapter', async () => {
    expect((await registry().execute('calendar_create', { kind: 'timed', summary: 'Reunión', startIso: '2026-10-11T16:00:00-05:00', endIso: '2026-10-11T17:00:00-05:00' }, context, 'op')).status).toBe('success');
    expect(google.createCalendarEvent).toHaveBeenCalledExactlyOnceWith(user.id, expect.objectContaining({
      startDateTime: new Date('2026-10-11T21:00:00Z'), endDateTime: new Date('2026-10-11T22:00:00Z'), timezone: user.timezone, allDay: false,
    }));
  });

  it('passes all-day dates to Google without converting them to UTC instants', async () => {
    google.createCalendarEvent.mockResolvedValueOnce({ id: 'fixture-event', summary: 'Feriado', start: '2026-10-11', end: '2026-10-12', isAllDay: true });
    expect(await registry().execute('calendar_create', { kind: 'all_day', summary: 'Feriado', startDate: '2026-10-11', endDateExclusive: '2026-10-12' }, context, 'op')).toMatchObject({ status: 'success', data: { events: [{ kind: 'all_day', startDate: '2026-10-11', endDateExclusive: '2026-10-12' }] } });
    expect(google.createCalendarEvent).toHaveBeenCalledExactlyOnceWith(user.id, expect.objectContaining({
      allDay: true, startDate: '2026-10-11', endDate: '2026-10-12', startDateTime: null, endDateTime: null,
    }));
  });

  it('returns authorization-required with CTA and does not create an event when disconnected', async () => {
    database.getUserIntegration.mockResolvedValueOnce(null);
    expect(await registry().execute('calendar_create', { kind: 'timed', summary: 'Reunión', startIso: '2026-10-11T21:00:00Z', endIso: '2026-10-11T22:00:00Z' }, context, 'op')).toMatchObject({ status: 'approval_required', data: { presentation: { cta: { url: 'https://example.test/oauth' } } } });
    expect(google.createCalendarEvent).not.toHaveBeenCalled();
  });
});

function completion(calls: ToolCall[] = []): AIResponse {
  return { message: { role: 'assistant', content: '', toolCalls: calls }, stopReason: calls.length ? 'tool_calls' : 'completed',
    usage: { inputTokens: 30, outputTokens: 10 } };
}
describe('multihop through canonical domain executors with isolated storage ports', () => {
  it('reads then completes the observed task and acknowledges its linked reminder after intent is journaled', async () => {
    const prepared: string[] = [];
    const journal: ProductivityExecutionJournal = { beforeDispatch: async call => { prepared.push(call.name); }, afterOutcome: async () => {} };
    database.updateTask.mockImplementation(async (_id: string, changes: Record<string, unknown>) => {
      expect(prepared).toEqual(['task_read', 'task_complete']);
      return { ...row, ...changes };
    });
    const provider = new MockAIProvider([{ response: completion([{ id: 'same', name: 'task_read', arguments: { scope: 'today' } }]) },
      { response: completion([{ id: 'same', name: 'task_complete', arguments: { taskId: id } }]) }, { response: completion() }], () => 100);
    const runner = new ProductivityTurnRunner(provider, registry(), {
      now: () => 100, continuation: 'observation_driven', authorizeWrite: async call => call.name === 'task_complete',
    });
    const result = await runner.run('Busca la propuesta; ya la terminé', context, undefined, journal);
    expect(result.uiPayload.items.map(item => item.status)).toEqual(['success', 'success']);
    expect(result.conversation.tasks[0]).toMatchObject({ id, status: 'completed' });
    expect(database.updateTask).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ status: 'completed' }), user.id);
    expect(database.acknowledgeRemindersByTaskId).toHaveBeenCalledExactlyOnceWith(id, user.id);
    expect(provider.requests).toHaveLength(3);
  });

  it('reads owned calendar then creates the requested event through the existing Google executor', async () => {
    const prepared: string[] = [];
    const journal: ProductivityExecutionJournal = { beforeDispatch: async call => { prepared.push(call.name); }, afterOutcome: async () => {} };
    google.createCalendarEvent.mockImplementationOnce(async (owner: string, _params: unknown) => {
      expect(owner).toBe(user.id);
      expect(prepared).toEqual(['calendar_read', 'calendar_create']);
      return { id: 'fixture-event', summary: 'Reunión', start: '2026-10-11T21:00:00Z', end: '2026-10-11T22:00:00Z', isAllDay: false };
    });
    const provider = new MockAIProvider([{ response: completion([{ id: 'same', name: 'calendar_read', arguments: { scope: 'today' } }]) },
      { response: completion([{ id: 'same', name: 'calendar_create', arguments: { kind: 'timed', summary: 'Reunión',
        startIso: '2026-10-11T21:00:00Z', endIso: '2026-10-11T22:00:00Z' } }]) }, { response: completion() }], () => 100);
    const runner = new ProductivityTurnRunner(provider, registry(), {
      now: () => 100, continuation: 'observation_driven', authorizeWrite: async call => call.name === 'calendar_create',
    });
    const result = await runner.run('Revisa mi agenda y añade la reunión a las 4', context, undefined, journal);
    expect(result.uiPayload.items.map(item => item.status)).toEqual(['success', 'success']);
    expect(result.conversation.events[0]?.id).toBe('fixture-event');
    expect(google.listCalendarEvents).toHaveBeenCalledExactlyOnceWith(user.id, expect.objectContaining({ timeMin: new Date(context.referenceTimeIso) }));
    expect(google.createCalendarEvent).toHaveBeenCalledTimes(1);
    expect(provider.requests).toHaveLength(3);
  });
});
