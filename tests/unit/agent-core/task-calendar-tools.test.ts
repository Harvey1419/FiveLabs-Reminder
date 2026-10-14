import { describe, expect, it, vi } from 'vitest';
import { createCalendarTools, createTaskTools, ToolRegistry } from '@templelabs/tools';
import type { TurnContext } from '@templelabs/contracts';
import { createLegacyTaskPort } from '../../../src/adapters/agent-core/legacy-tasks.js';
import { createLegacyCalendarPort } from '../../../src/adapters/agent-core/legacy-calendar.js';
import type { LegacyToolRequest } from '../../../src/agent/tools/index.js';

const id = '11111111-1111-4111-8111-111111111111';
const user = { id: 'fixture-owner', phone_number: '+573000000001' };
const context: TurnContext = {
  userId: user.id, runId: 'fixture-run', requestId: 'fixture-request', timezone: 'America/Bogota',
  language: 'es', referenceTimeIso: '2026-10-11T17:49:00Z', signal: new AbortController().signal,
  capabilities: new Set(['tasks.create', 'tasks.read', 'tasks.update', 'tasks.complete', 'tasks.delete',
    'calendar.read', 'calendar.create', 'calendar.connect']),
};
const task = { id, title: 'Enviar propuesta', dueDate: '2026-10-11T21:00:00Z', priority: 'high' };
const event = { id: 'google-event-1', summary: 'Reunión', start: '2026-10-11T21:00:00Z', end: '2026-10-11T22:00:00Z', isAllDay: false };
const timed = { kind: 'timed', summary: event.summary, startIso: event.start, endIso: event.end };
function setup(raw: unknown) {
  const execute = vi.fn<(request: LegacyToolRequest) => Promise<unknown>>().mockResolvedValue(raw);
  const registry = new ToolRegistry([
    ...createTaskTools(createLegacyTaskPort(user, execute)),
    ...createCalendarTools(createLegacyCalendarPort(user, execute)),
  ]);
  return { registry, execute };
}

describe('atomic task and calendar contracts', () => {
  it.each([
    ['task_create', { title: 'Comprar pan', userId: 'foreign' }],
    ['task_create', { title: 'Comprar pan', priority: 'important' }],
    ['task_create', { title: 'Comprar pan', dueDateIso: 'mañana' }],
    ['task_create', { title: 'Comprar pan', entityCategory: 'company' }],
    ['task_update', { taskId: id }],
    ['task_update', { taskId: id, appendDescription: true, description: null }],
    ['task_update', { taskId: id, title: 'Cambiar', status: 'completed' }],
    ['task_complete', { taskId: 'primera' }],
    ['task_delete', { taskId: id, scope: 'all' }],
    ['task_read', { limit: 500 }],
    ['calendar_create', { ...timed, endIso: event.start }],
    ['calendar_create', { ...timed, isPro: true }],
    ['calendar_create', { ...timed, startDate: '2026-10-11' }],
    ['calendar_create', { kind: 'all_day', summary: 'Feriado', startDate: '2026-10-11', endDateExclusive: '2026-10-11' }],
    ['calendar_create', { kind: 'all_day', summary: 'Feriado', startDate: '2026-10-11', endDateExclusive: '2026-10-12', advanceMinutes: 15 }],
  ])('rejects invalid %s arguments without dispatch', async (name, input) => {
    const { registry, execute } = setup(null);
    expect((await registry.execute(name, input, context, 'op')).status).toBe('validation_failed');
    expect(execute).not.toHaveBeenCalled();
  });

  it('scopes tools and checks authenticated owner before domain dispatch', async () => {
    const { registry, execute } = setup(null);
    const scoped = { ...context, capabilities: new Set(['tasks.read', 'calendar.read']) };
    expect(registry.available(scoped).map(tool => tool.name)).toEqual(['task_read', 'calendar_read']);
    expect((await registry.execute('task_delete', { taskId: id }, scoped, 'op')).status).toBe('denied');
    expect(await registry.execute('task_read', {}, { ...context, userId: 'foreign' }, 'op')).toMatchObject({ status: 'denied', code: 'OWNER_MISMATCH' });
    expect(await registry.execute('calendar_read', {}, { ...context, timezone: 'invalid-zone' }, 'op')).toMatchObject({ status: 'validation_failed', code: 'INVALID_TIMEZONE' });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('task mapping and effects', () => {
  it('keeps reminder outcome unverified when legacy confirms only the created task', async () => {
    const { registry, execute } = setup({ success: true, action: 'created_tasks_batch', data: [task] });
    const outcome = await registry.execute('task_create', { title: task.title, dueDateIso: task.dueDate }, context, 'op');
    expect(outcome).toMatchObject({ status: 'partial', receipt: { resourceIds: [id] }, data: { issues: [{ code: 'COMPANION_OUTCOME_UNVERIFIED' }] } });
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ toolName: 'manage_task', user: { id: user.id, timezone: context.timezone }, referenceTime: new Date(context.referenceTimeIso),
      params: { action: 'create', items: [{ title: task.title, dueDate: task.dueDate }] } });
  });

  it('confirms creation without a requested linked reminder', async () => {
    const { registry } = setup({ success: true, action: 'created_tasks_batch', data: [task] });
    expect((await registry.execute('task_create', { title: task.title, dueDateIso: task.dueDate, scheduleReminder: false }, context, 'op')).status).toBe('success');
  });

  it('maps null clears and append descriptions without changing lifecycle status', async () => {
    const { registry, execute } = setup({ success: true, action: 'updated_task', data: task });
    expect((await registry.execute('task_update', { taskId: id, dueDateIso: null, description: 'Anexo', appendDescription: true }, context, 'op')).status).toBe('success');
    expect(execute.mock.calls[0]?.[0].params).toEqual({ action: 'update', target: id, updates: { dueDate: null, description: 'Anexo', append: true } });
  });

  it.each(['complete', 'delete'])('retains principal %s receipts after companion cleanup failure', async operation => {
    const { registry } = setup({ success: true, action: operation === 'complete' ? 'completed_task_partial' : 'deleted_task_partial', partialSuccess: true, complete: false, data: task });
    expect(await registry.execute(`task_${operation}`, { taskId: id }, context, 'op')).toMatchObject({ status: 'partial', receipt: { resourceIds: [id] }, data: { records: [{ status: operation === 'complete' ? 'completed' : 'deleted' }] } });
  });

  it('rejects a successful write receipt for a different task', async () => {
    const { registry } = setup({ success: true, action: 'updated_task', data: { ...task, id: '22222222-2222-4222-8222-222222222222' } });
    expect((await registry.execute('task_update', { taskId: id, title: 'Cambio' }, context, 'op')).status).toBe('indeterminate');
  });

  it('keeps task flows in presentation data and strips raw row metadata from observation', async () => {
    const flow = { flowId: 'fixture-flow', buttonText: 'Completar', flowToken: 'fixture-token', flowAction: 'navigate', screen: 'TASK_SELECTION', mode: 'draft', data: { tasks: [{ id, title: 'Propuesta', description: '' }] } };
    const { registry, execute } = setup({ success: true, action: 'listed_tasks', data: { tasks: [{ ...task, description: 'internal-notes', user_id: 'owner-secret' }] }, flow });
    const outcome = await registry.execute('task_read', { scope: '2026-10-11' }, context, 'op');
    expect(outcome).toMatchObject({ status: 'success', data: { flow, coverage: 'bounded_list' } });
    expect(outcome.observation).not.toContain('owner-secret');
    expect(outcome.observation).not.toContain('internal-notes');
    expect(outcome.observation).not.toContain('fixture-token');
    expect(execute.mock.calls[0]?.[0].params).toMatchObject({ scope: 'explicit_date@2026-10-11', limit: 50 });
  });
});

describe('calendar civil dates, connection and companion outcomes', () => {
  it('keeps all-day start and exclusive end as civil dates', async () => {
    const { registry, execute } = setup({ success: true, action: 'google_event_created', data: { id: event.id, summary: 'Feriado', start: '2026-10-11', end: '2026-10-12', isAllDay: true } });
    expect(await registry.execute('calendar_create', { kind: 'all_day', summary: 'Feriado', startDate: '2026-10-11', endDateExclusive: '2026-10-12' }, context, 'op')).toMatchObject({ status: 'success', data: { events: [{ kind: 'all_day', startDate: '2026-10-11', endDateExclusive: '2026-10-12' }] } });
    expect(execute.mock.calls[0]?.[0].params).toEqual({ action: 'create_event', summary: 'Feriado', allDay: true, startDate: '2026-10-11', endDate: '2026-10-12' });
  });

  it.each([true, false])('reports requested companion confirmation %s separately from event creation', async reminderCreated => {
    const { registry } = setup({ success: true, action: 'google_event_created', data: { ...event, reminderCreated } });
    expect(await registry.execute('calendar_create', { ...timed, advanceMinutes: 15 }, context, 'op')).toMatchObject({ status: reminderCreated ? 'success' : 'partial', data: { companion: reminderCreated ? 'confirmed' : 'unconfirmed' }, receipt: { resourceIds: [event.id] } });
  });

  it('preserves auth link on approval-required outcome without claiming a write', async () => {
    const { registry, execute } = setup({ success: false, action: 'google_not_connected', errorCode: 'AUTH_REQUIRED', ctaUrl: 'https://example.test/oauth' });
    expect(await registry.execute('calendar_create', timed, { ...context, language: 'en' }, 'op')).toMatchObject({ status: 'approval_required', code: 'AUTH_REQUIRED', data: { connection: 'authorization_required', presentation: { cta: { url: 'https://example.test/oauth' } } } });
    expect(execute.mock.calls[0]?.[0].user.locale).toBe('en-US');
  });

  it('distinguishes generating a connection link from having connected', async () => {
    const { registry, execute } = setup({ success: true, action: 'google_auth_link_generated', ctaUrl: 'https://example.test/oauth' });
    expect(await registry.execute('calendar_connect', {}, context, 'op')).toMatchObject({ status: 'success', data: { connection: 'authorization_required' } });
    execute.mockResolvedValueOnce({ success: true, action: 'already_connected', data: { email: 'private@example.test' } });
    const connected = await registry.execute('calendar_connect', {}, context, 'op2');
    expect(connected).toMatchObject({ status: 'success', data: { connection: 'connected' } });
    expect(connected.observation).not.toContain('private@example.test');
  });

  it('handles empty and next-event list shapes using bounded coverage', async () => {
    const { registry, execute } = setup({ success: true, action: 'google_events_listed', data: [] });
    expect(await registry.execute('calendar_read', {}, context, 'op')).toMatchObject({ status: 'success', data: { events: [], coverage: 'bounded_list' } });
    execute.mockResolvedValueOnce({ success: true, action: 'google_events_listed', data: { events: [event] } });
    expect((await registry.execute('calendar_read', { scope: 'next_event' }, context, 'op2')).status).toBe('success');
    expect(execute.mock.calls[1]?.[0].params.action).toBe('next_event');
  });

  it('never retries unknown calendar writes and treats unknown reads as failed', async () => {
    const { registry, execute } = setup({ success: false, action: 'error', outcome: 'unknown' });
    expect((await registry.execute('calendar_create', timed, context, 'op')).status).toBe('indeterminate');
    expect((await registry.execute('calendar_read', {}, context, 'op2')).status).toBe('failed');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed provider identities without coercing them into confirmed receipts', async () => {
    const { registry } = setup({ success: true, action: 'google_event_created', data: { ...event, id: 42 } });
    expect((await registry.execute('calendar_create', timed, context, 'op')).status).toBe('indeterminate');
  });
});
