import { describe, expect, it, vi } from 'vitest';
import type { TaskRequest, ReminderRequest, CalendarRequest, TurnContext } from '@templelabs/contracts';
import { createTaskService, type TaskServiceHandlers } from '../../../src/features/tasks/productivity-service.js';
import { createReminderService, type ReminderServiceHandlers } from '../../../src/features/reminders/productivity-service.js';
import { createCalendarService, type CalendarServiceHandler } from '../../../src/features/calendar/productivity-service.js';
import { createTaskDomainPort } from '../../../src/adapters/agent-core/tasks-domain.js';
import { createReminderDomainPort } from '../../../src/adapters/agent-core/reminders-domain.js';
import { createCalendarDomainPort } from '../../../src/adapters/agent-core/calendar-domain.js';
import { withTurnLease } from '../../../src/agent/core/turn-lease.js';

// Loading any V1 dispatcher from these service/port roots fails the test immediately.
vi.mock('../../../src/agent/tools/index.js', () => { throw new Error('V1 dispatcher imported by native domain'); });
const id = '11111111-1111-4111-8111-111111111111';
const user = { id: 'owner', timezone: 'America/Bogota' };
const context: TurnContext = { userId: 'owner', runId: 'run', requestId: 'request', language: 'es', timezone: user.timezone,
  referenceTimeIso: '2026-10-14T15:55:00Z', signal: new AbortController().signal, capabilities: new Set(['reminders.pro']) };
function lease() {
  return { inboundTurn: { id: 'run', messageId: 'request', threadId: 'thread', response: {} }, signal: context.signal,
    assertActive: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}) };
}
const task = { id, title: 'Meeting', status: 'pending' };
const reminder = { id, content: 'Meeting', sendAt: '2026-10-14T16:05:00Z' };
const event = { id, summary: 'Meeting', start: '2026-10-14T16:05:00Z', end: '2026-10-14T17:05:00Z', isAllDay: false };

describe('typed productivity services bypass V1 dispatch', () => {
  const tasks: TaskRequest[] = [
    { operation: 'create', input: { title: 'Meeting', scheduleReminder: false } }, { operation: 'read', input: {} },
    { operation: 'update', input: { taskId: id, priority: 'high' } }, { operation: 'complete', input: { taskId: id } },
    { operation: 'delete', input: { taskId: id } },
  ];
  it.each(tasks)('routes task $operation to its domain handler with an owned receipt', async request => {
    const operations: TaskServiceHandlers = {
      create: vi.fn(async () => ({ success: true, action: 'created_tasks_batch', data: [task] })),
      read: vi.fn(async () => ({ success: true, action: 'listed_tasks', data: { tasks: [task] } })),
      update: vi.fn(async () => ({ success: true, action: 'updated_task', data: task })),
      complete: vi.fn(async () => ({ success: true, action: 'completed_task', data: task })),
      delete: vi.fn(async () => ({ success: true, action: 'deleted_task', data: task })),
    };
    const active = lease();
    const port = createTaskDomainPort(user, createTaskService(user, operations));
    const result = await withTurnLease(active, () => port.execute(request, context, 'operation'));
    expect(result).toMatchObject({ status: 'success', receipt: { userId: user.id, operationId: 'operation', resourceIds: [id] } });
    expect(operations[request.operation]).toHaveBeenCalledOnce();
    expect(operations[request.operation]).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ id: user.id }), language: 'es', referenceTime: new Date(context.referenceTimeIso) }));
    expect(active.assertActive).toHaveBeenCalledOnce();
  });
  const reminders: ReminderRequest[] = [
    { operation: 'create', input: { content: 'Meeting', targetTimeIso: reminder.sendAt } }, { operation: 'read', input: {} },
    { operation: 'update', input: { reminderId: id, content: 'Updated meeting' } },
    { operation: 'cancel', input: { reminderId: id } }, { operation: 'acknowledge', input: { reminderId: id } },
  ];
  it.each(reminders)('routes reminder $operation directly and retains the operation receipt', async request => {
    const operations: ReminderServiceHandlers = {
      create: vi.fn(async () => ({ success: true, action: 'created_reminders_batch', data: [reminder] })),
      read: vi.fn(async () => ({ success: true, action: 'listed_reminders', data: { reminders: [reminder] } })),
      update: vi.fn(async () => ({ success: true, action: 'updated_reminder', data: reminder })),
      cancel: vi.fn(async () => ({ success: true, action: 'cancelled_reminder', data: { cancelledReminders: [{ ...reminder, status: 'cancelled' }] } })),
      acknowledge: vi.fn(async () => ({ success: true, action: 'acknowledged_reminder', data: reminder })),
    };
    const result = await withTurnLease(lease(), () => createReminderDomainPort(user, createReminderService(user, operations)).execute(request, context, 'operation'));
    expect(result).toMatchObject({ status: 'success', receipt: { userId: user.id, resourceIds: [id] } });
    expect(operations[request.operation]).toHaveBeenCalledOnce();
    expect(operations[request.operation]).toHaveBeenCalledWith(expect.objectContaining({ isPro: true, correlationId: context.requestId }));
  });
  const calendars: CalendarRequest[] = [
    { operation: 'connect', input: {} }, { operation: 'read', input: { scope: 'today' } },
    { operation: 'create', input: { kind: 'timed', summary: 'Meeting', startIso: event.start, endIso: event.end } },
    { operation: 'update', input: { eventId: id, lookupDate: '2026-10-14', description: null } },
    { operation: 'delete', input: { eventId: id, lookupDate: '2026-10-14' } },
  ];
  it.each(calendars)('routes calendar $operation and verifies scoped ownership before mutations', async request => {
    const execute = vi.fn<CalendarServiceHandler>(async input => input.action === 'list_events'
      ? { success: true, action: 'google_events_listed', data: [event] }
      : input.action === 'get_connect_link' ? { success: true, action: 'already_connected', data: {} }
        : input.action === 'delete_event' ? { success: true, action: 'google_event_deleted', data: { eventId: id, deleted: true } }
          : { success: true, action: input.action === 'update_event' ? 'google_event_updated' : 'google_event_created', data: event });
    const result = await withTurnLease(lease(), () => createCalendarDomainPort(user, createCalendarService(user, execute)).execute(request, context, 'operation'));
    expect(result.status).toBe('success');
    expect(execute).toHaveBeenCalledTimes(['update', 'delete'].includes(request.operation) ? 2 : 1);
    if (request.operation === 'update' || request.operation === 'delete') expect(execute.mock.calls[0]?.[0]).toMatchObject({ action: 'list_events', params: { scope: 'explicit_date', date: '2026-10-14' } });
    if (request.operation === 'update') expect(execute.mock.calls[1]?.[0].params).toMatchObject({ description: '', target: id });
  });
  it('rejects an unleased or mismatched turn before invoking a domain mutation', async () => {
    const execute = vi.fn<CalendarServiceHandler>();
    const service = createCalendarService(user, execute);
    const request: CalendarRequest = { operation: 'delete', input: { eventId: id, lookupDate: '2026-10-14' } };
    await expect(service.execute(request, context)).rejects.toMatchObject({ code: 'INBOUND_LEASE_REQUIRED' });
    await expect(withTurnLease(lease(), () => service.execute(request, { ...context, runId: 'other' }))).rejects.toThrow('DOMAIN_TURN_MISMATCH');
    await expect(withTurnLease(lease(), () => service.execute(request, { ...context, userId: 'other' }))).rejects.toThrow('DOMAIN_OWNER_MISMATCH');
    expect(execute).not.toHaveBeenCalled();
  });
  it('never promotes an unknown domain write to success even when a handler returns success and partial flags', async () => {
    const execute = vi.fn<CalendarServiceHandler>(async () => ({ success: true, partialSuccess: true, outcome: 'unknown', action: 'google_event_created', data: event }));
    const port = createCalendarDomainPort(user, createCalendarService(user, execute));
    const request: CalendarRequest = { operation: 'create', input: { kind: 'timed', summary: event.summary, startIso: event.start, endIso: event.end } };
    const result = await withTurnLease(lease(), () => port.execute(request, context, 'operation'));
    expect(result).toMatchObject({ status: 'indeterminate', operationId: 'operation' });
    expect(result).not.toHaveProperty('receipt'); expect(execute).toHaveBeenCalledOnce();
  });
});
