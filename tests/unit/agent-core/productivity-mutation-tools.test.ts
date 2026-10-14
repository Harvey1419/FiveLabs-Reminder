import { describe, it, expect, vi } from 'vitest';
import { createCalendarTools, createReminderTools, createTaskTools, ToolRegistry } from '@templelabs/tools';
import type { TurnContext } from '@templelabs/contracts';
import type { LegacyToolRequest } from '../../../src/agent/tools/index.js';
import { createLegacyReminderPort } from '../../../src/adapters/agent-core/legacy-reminders.js';
import { createLegacyTaskPort } from '../../../src/adapters/agent-core/legacy-tasks.js';
import { createLegacyCalendarPort } from '../../../src/adapters/agent-core/legacy-calendar.js';
const id = '11111111-1111-4111-8111-111111111111';
const context: TurnContext = { userId: 'owner', runId: 'run', requestId: 'request', language: 'es', timezone: 'America/Bogota',
  referenceTimeIso: '2026-10-14T12:00:00Z', signal: new AbortController().signal,
  capabilities: new Set(['reminders.cancel','tasks.delete','calendar.update','calendar.delete']) };
const event = { id: 'event', summary: 'Call', start: '2026-10-14T20:00:00Z', end: '2026-10-14T21:00:00Z', isAllDay: false };
function setup() {
  const execute = vi.fn<(request: LegacyToolRequest) => Promise<unknown>>();
  const user = { id: context.userId };
  const registry = new ToolRegistry([...createReminderTools(createLegacyReminderPort(user, execute)),
    ...createTaskTools(createLegacyTaskPort(user, execute)), ...createCalendarTools(createLegacyCalendarPort(user, execute))]);
  return { execute, registry };
}
describe('productivity mutation parity', () => {
  it('cancels a recurring routine and its linked notices with confirmed IDs and status', async () => {
    const f = setup(); f.execute.mockResolvedValue({ success: true, complete: true, action: 'cancelled_recurring_reminder_series',
      data: { cancelledCount: 1, cancelledReminders: [{ id, content: 'Amoxicilina 500 mg', status: 'cancelled', recurrenceRule: 'daily' }] } });
    expect(await f.registry.execute('reminder_cancel', { reminderId: id }, context, 'cancel')).toMatchObject({ status: 'success',
      data: { operation: 'cancel', records: [{ id, status: 'cancelled' }], complete: true }, receipt: { resourceIds: [id] } });
    expect(f.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ params: { action: 'cancel', target: id }, user: { id: 'owner', timezone: context.timezone, locale: 'es-CO' } }));
  });
  it('reports partial cancellation and already-inactive outcomes without a fabricated full success', async () => {
    const f = setup(); f.execute.mockResolvedValueOnce({ success: true, partialSuccess: true, complete: false, action: 'cancelled_reminder',
      data: { cancelledReminders: [{ id, content: 'Routine', status: 'cancelled' }] } })
      .mockResolvedValueOnce({ success: false, complete: true, action: 'reminder_already_inactive', data: { targetId: id } });
    expect(await f.registry.execute('reminder_cancel', { reminderId: id }, context, 'one')).toMatchObject({ status: 'partial', data: { complete: false } });
    expect(await f.registry.execute('reminder_cancel', { reminderId: id }, context, 'two')).toMatchObject({ status: 'failed', code: 'ALREADY_INACTIVE' });
  });
  it('deletes one owned task using the existing domain mutation', async () => {
    const f = setup(); f.execute.mockResolvedValue({ success: true, action: 'deleted_task', data: { id, title: 'Report' } });
    expect(await f.registry.execute('task_delete', { taskId: id }, context, 'delete')).toMatchObject({ status: 'success', data: { operation: 'delete', records: [{ id, status: 'deleted' }] } });
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ params: { action: 'delete', target: id } }));
  });
  it('updates a verified calendar event with an original date scope and exact ID', async () => {
    const f = setup(); f.execute.mockResolvedValueOnce({ success: true, action: 'google_events_listed', data: [event] })
      .mockResolvedValueOnce({ success: true, action: 'google_event_updated', data: { ...event, summary: 'Updated' } });
    expect(await f.registry.execute('calendar_update', { eventId: 'event', lookupDate: '2026-10-14', summary: 'Updated' }, context, 'update')).toMatchObject({ status: 'success', data: { operation: 'update', events: [{ id: 'event', summary: 'Updated' }] } });
    expect(f.execute.mock.calls[0]?.[0].params).toEqual({ action: 'list_events', scope: 'explicit_date', date: '2026-10-14' });
    expect(f.execute.mock.calls[1]?.[0].params).toEqual({ action: 'update_event', target: 'event', lookupDate: '2026-10-14', summary: 'Updated' });
  });
  it('deletes a verified calendar event and records linked-reminder uncertainty as partial', async () => {
    const f = setup(); f.execute.mockResolvedValueOnce({ success: true, action: 'google_events_listed', data: [event] })
      .mockResolvedValueOnce({ success: true, partialSuccess: true, complete: false, action: 'google_event_deleted', data: { eventId: 'event', deleted: true, companionCancelled: false } });
    expect(await f.registry.execute('calendar_delete', { eventId: 'event', lookupDate: '2026-10-14' }, context, 'delete')).toMatchObject({ status: 'partial', receipt: { resourceIds: ['event'] }, data: { operation: 'delete', companion: 'unconfirmed' } });
  });
  it('never mutates an event absent from the authenticated date scope', async () => {
    const f = setup(); f.execute.mockResolvedValue({ success: true, action: 'google_events_listed', data: [] });
    expect(await f.registry.execute('calendar_delete', { eventId: 'foreign', lookupDate: '2026-10-14' }, context, 'delete')).toMatchObject({ status: 'failed', code: 'NOT_FOUND' });
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it.each([
    ['reminder_cancel', { reminderId: 'first' }], ['reminder_cancel', { reminderId: id, userId: 'foreign' }],
    ['calendar_update', { eventId: 'event', lookupDate: '2026-10-14' }],
    ['calendar_update', { eventId: 'event', lookupDate: '2026-10-14', startIso: '2026-02-29T12:00:00Z' }],
    ['calendar_delete', { eventId: 'event' }], ['calendar_delete', { eventId: 'event', lookupDate: 'today' }],
  ])('rejects invalid %s inputs before any domain dispatch', async (name, input) => {
    const f = setup(); expect((await f.registry.execute(name, input, context, 'invalid')).status).toBe('validation_failed'); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(['reminder_cancel','task_delete','calendar_delete','calendar_update'])('requires the owner and capability for %s', async name => {
    const f = setup(), input = name === 'reminder_cancel' ? { reminderId: id } : name === 'task_delete' ? { taskId: id } : { eventId: 'event', lookupDate: '2026-10-14', ...(name === 'calendar_update' ? { summary: 'Change' } : {}) };
    expect((await f.registry.execute(name, input, { ...context, capabilities: new Set() }, 'missing')).status).toBe('denied');
    expect((await f.registry.execute(name, input, { ...context, userId: 'foreign' }, 'foreign')).status).toBe('denied'); expect(f.execute).not.toHaveBeenCalled();
  });
});
