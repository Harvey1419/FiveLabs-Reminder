import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ReminderRow } from '../../../src/agent/tools/reminder-tool-ports.js';
const state = vi.hoisted(() => ({ rows: [] as ReminderRow[] }));
vi.mock('../../../src/infrastructure/database/index.js', () => ({
  supabase: { from: vi.fn(() => {
    const query = { select: vi.fn(() => query), eq: vi.fn(() => query), or: vi.fn(() => query),
      in: vi.fn(() => query), order: vi.fn(() => query), limit: vi.fn(async () => ({ data: state.rows, error: null })) };
    return query;
  }) },
  saveReminder: vi.fn(async (input: { content: string; sendAt: string; userId: string; parentReminderId?: string; source?: string }) => {
    const row = { id: 'new-advance', user_id: input.userId, content: input.content, send_at: input.sendAt,
      ...(input.parentReminderId !== undefined ? { parent_reminder_id: input.parentReminderId } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}), status: 'pending', acknowledged_at: null };
    state.rows.push(row);
    return row;
  }),
  updateReminder: vi.fn(), getUserSubscription: vi.fn(async () => null),
  hasProAccess: vi.fn(() => true), shouldEnforceBillingForUser: vi.fn(() => false),
}));
import { noticeWeekdayMessage } from '../../fixtures/agent/behavioral-notice-weekday-fixtures.js';
import { normalizeCalendarEvent as normalizeGoogleEvent } from '../../../src/integrations/google/calendar.js';
import { behavioralCalendarDeliveryActions, behavioralCalendarDeliveryMessage } from '../../fixtures/agent/behavioral-calendar-delivery-fixtures.js';
import { getStructuredTurnSchema } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { matchesSchema } from '../../../src/agent/contracts/schema-value-contract.js';
import { validateForegroundContent } from '../../../src/agent/contracts/foreground-turn-validator.js';
import { buildDomainCall } from '../../../src/agent/orchestration/domain-call.js';
import { createCalendarTool } from '../../../src/agent/tools/calendar-tool.js';
import { executeReminderUpdate } from '../../../src/agent/tools/reminder-update.js';
import { saveReminder, updateReminder } from '../../../src/infrastructure/database/index.js';
import { createAgendaReadService } from '../../../src/features/agenda/agenda-read-service.js';
import type { FeatureQuery, FeatureRow } from '../../../src/features/read-model-ports.js';
import { normalizeAgendaScope, isAllPendingScope } from '../../../src/shared/agenda-scopes.js';
import { formatCanonicalAgenda } from '../../../src/shared/agenda-presentation.js';
import * as time from '../../../src/shared/time.js';
import { formatRecurrenceLabel } from '../../../src/shared/reminder-presentation.js';
import { parseStructuredOrdinal, resolveContextReference } from '../../../src/agent/core/context-reference.js';
import { clearWorkingMemory, saveWorkingMemory } from '../../../src/agent/core/working-memory.js';

const user = { id: 'calendar-delivery-owner', phone_number: '573990001122', timezone: 'America/Bogota' };
const referenceTime = new Date('2026-09-02T17:00:00Z');
beforeEach(() => { vi.clearAllMocks(); state.rows = []; clearWorkingMemory(user); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(referenceTime);
  saveWorkingMemory(user, { source: 'reminder', items: [{ type: 'reminder', internalId: '11111111-1111-4111-8111-111111111111', summary: 'Cita con el cliente', time: '2026-09-03T15:00:00Z' }] });
});
afterEach(() => { vi.useRealTimers(); clearWorkingMemory(user); });

function domainCall(key: keyof typeof behavioralCalendarDeliveryActions) {
  const message = behavioralCalendarDeliveryMessage(key);
  expect(matchesSchema(JSON.parse(message.content), getStructuredTurnSchema() as Parameters<typeof matchesSchema>[1])).toBe(true);
  const validation = validateForegroundContent(message.content);
  if (!validation.valid) throw new Error(validation.error);
  const call = buildDomainCall(validation.intent.actions[0], { user, timezone: user.timezone, language: 'es', referenceTime });
  if (!call.valid || !('toolName' in call)) throw new Error('Expected domain call');
  return call;
}

function calendarFixture() {
  const saveCompanion = vi.fn(async () => ({ id: 'gcal-companion' }));
  const createCalendarEvent = vi.fn(async () => ({ id: 'gcal-event-12345', summary: 'Reunión de trabajo' }));
  const deps = {
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
    parseStructuredOrdinal, resolveContextReference, getWorkingMemory: () => null,
    getNow: () => referenceTime, getNowMs: () => referenceTime.getTime(), logger: console,
  };
  return { ...createCalendarTool(deps), saveCompanion, createCalendarEvent };
}

describe('current calendar and delivery integration fixtures', () => {
  it.each(Object.keys(behavioralCalendarDeliveryActions) as (keyof typeof behavioralCalendarDeliveryActions)[])('%s selects the current domain protocol', key => {
    const call = domainCall(key);
    if (key.startsWith('calendar')) {
      expect(call.toolName).toBe('manage_google_calendar');
      expect(call.params).toMatchObject({ action: 'create_event', startDateTime: '2026-09-03T14:00:00.000Z', durationMinutes: 60 });
    } else if (key === 'advanceExisting') {
      expect(call.params).toMatchObject({ action: 'update', target: '11111111-1111-4111-8111-111111111111', deliveryPolicy: { advanceNotice: 'offset', advanceMinutes: 15 } });
      expect(call.params.updates).toEqual({});
    } else expect(call).toMatchObject({ toolName: 'get_unified_agenda', params: { scope: 'upcoming' } });
  });

  it('explicit calendar notice creates one companion at the exact offset and binds its event identity', async () => {
    const f = calendarFixture(), call = domainCall('calendarWithNotice');
    const result = await f.executeCalendarTool({ action: String(call.params.action), params: call.params, user, language: 'es', referenceTime });
    expect(result.success).toBe(true);
    expect(f.createCalendarEvent).toHaveBeenCalledExactlyOnceWith(user.id, expect.objectContaining({
      startDateTime: new Date('2026-09-03T14:00:00Z'), endDateTime: new Date('2026-09-03T15:00:00Z'),
    }));
    expect(f.saveCompanion).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      userId: user.id, sendAt: '2026-09-03T13:45:00.000Z', deliveryId: 'gcal:gcal-event-12345', source: 'gcal_companion',
    }));
    expect(result.formattedCard).toContain('Recordatorio programado en WhatsApp');
  });

  it('calendar creation without an explicit notice creates no companion reminder', async () => {
    const f = calendarFixture(), call = domainCall('calendarWithoutNotice');
    const result = await f.executeCalendarTool({ action: String(call.params.action), params: call.params, user, language: 'es', referenceTime });
    expect(result.success).toBe(true);
    expect(f.createCalendarEvent).toHaveBeenCalledTimes(1);
    expect(f.saveCompanion).not.toHaveBeenCalled();
    expect(result.formattedCard).not.toContain('Recordatorio programado en WhatsApp');
  });

  it('upcoming agenda applies future bounds and owner scope while retaining later dates', async () => {
    const rows: FeatureRow[] = [
      { id: 'past', content: 'Recordatorio pasado de la mañana', send_at: '2026-09-02T15:00:00Z', status: 'pending', acknowledged_at: null },
      { id: 'tomorrow', content: 'Cita médica mañana', send_at: '2026-09-03T17:00:00Z', status: 'pending', acknowledged_at: null },
      { id: 'later', content: 'Reunión en Cerámica Italia', send_at: '2026-09-09T15:00:00Z', status: 'pending', acknowledged_at: null },
    ];
    const ownerScopes: string[] = [], lowerBounds: string[] = [];
    const service = createAgendaReadService({
      supabase: { from(table) {
        let data = table === 'reminders' ? [...rows] : [];
        const query: FeatureQuery = {
          select: () => query, eq: () => query,
          or: expression => { if (table === 'reminders') ownerScopes.push(expression); return query; },
          gte: (column, value) => { if (table === 'reminders') lowerBounds.push(value); data = data.filter(row => String(row[column]) >= value); return query; },
          lt: (column, value) => { data = data.filter(row => String(row[column]) < value); return query; },
          lte: () => query, like: () => query, in: () => query, order: () => query, limit: () => query,
          maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
          then: (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject),
        };
        return query;
      } },
      getUserIntegration: async () => null, hasUsableGoogleCredentials: () => false, isGoogleAuthError: () => false,
      listCalendarEvents: async () => [], normalizeCalendarEvent: event => event,
      resolveCalendarTemporalScope: time.resolveCalendarTemporalScope, formatLocalDateTime: time.formatLocalDateTime,
      normalizeAgendaScope, isAllPendingScope, getNow: () => referenceTime, logger: console,
    });
    const agenda = await service.getUnifiedAgenda({ userId: user.id, phoneNumber: user.phone_number, timezone: user.timezone, scope: String(domainCall('upcomingAgenda').params.scope) });
    expect(lowerBounds).toEqual([referenceTime.toISOString()]);
    expect(ownerScopes).toEqual([`user_id.eq.${user.id},phone_number.eq.${user.phone_number}`]);
    expect(agenda.reminders.map(row => row.id)).toEqual(['tomorrow', 'later']);
    const card = formatCanonicalAgenda(agenda, { language: 'es', timezone: user.timezone });
    expect(card).toContain('Cita médica mañana');
    expect(card).toContain('Reunión en Cerámica Italia');
    expect(card).not.toContain('Recordatorio pasado de la mañana');
  });

  it('Friday agenda requests exact weekday bounds and presents only the returned Friday events', async () => {
    const message = noticeWeekdayMessage('fridayAgenda');
    const validation = validateForegroundContent(message.content);
    if (!validation.valid) throw new Error(validation.error);
    const selected = buildDomainCall(validation.intent.actions[0], { user, timezone: user.timezone, referenceTime });
    if (!selected.valid || !('toolName' in selected)) throw new Error('Expected agenda read');
    const events = [
      { id: 'thu', summary: 'Reunión Jueves', start: { dateTime: '2026-09-03T10:00:00-05:00' } },
      { id: 'fri-1', summary: 'Reunión Planeación Viernes', start: { dateTime: '2026-09-04T10:00:00-05:00' } },
      { id: 'fri-2', summary: 'Almuerzo Clientes Viernes', start: { dateTime: '2026-09-04T13:00:00-05:00' } },
      { id: 'mon', summary: 'Reunión Lunes Próximo', start: { dateTime: '2026-09-07T09:00:00-05:00' } },
    ];
    const listCalendarEvents = vi.fn(async (_owner: string, options: { timeMin: Date; timeMax: Date | null }) => events.filter(event => {
      const stamp = new Date(event.start.dateTime).getTime();
      return stamp >= options.timeMin.getTime() && stamp < options.timeMax!.getTime();
    }));
    const service = createAgendaReadService({
      supabase: { from: () => {
        const query: FeatureQuery = { select: () => query, eq: () => query, or: () => query,
          gte: () => query, lt: () => query, lte: () => query, like: () => query, in: () => query, order: () => query, limit: () => query,
          maybeSingle: async () => ({ data: null, error: null }),
          then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject) };
        return query;
      } },
      getUserIntegration: async () => ({ id: 'weekday-integration', user_id: user.id, provider: 'google', access_token: 'synthetic' }),
      hasUsableGoogleCredentials: () => true, isGoogleAuthError: () => false, listCalendarEvents,
      normalizeCalendarEvent: (event, timezone) => ({ ...normalizeGoogleEvent(event, timezone), id: event.id }),
      resolveCalendarTemporalScope: time.resolveCalendarTemporalScope, formatLocalDateTime: time.formatLocalDateTime,
      normalizeAgendaScope, isAllPendingScope, getNow: () => referenceTime, logger: console,
    });
    const agenda = await service.getUnifiedAgenda({ userId: user.id, timezone: user.timezone, scope: String(selected.params.scope) });
    expect(listCalendarEvents).toHaveBeenCalledExactlyOnceWith(user.id, expect.objectContaining({ timeMin: new Date('2026-09-04T05:00:00Z'), timeMax: new Date('2026-09-05T05:00:00Z') }));
    expect(agenda.calendar.events.map(event => event.id)).toEqual(['fri-1', 'fri-2']);
    const card = formatCanonicalAgenda(agenda, { language: 'es', timezone: user.timezone });
    expect(card).toContain('Reunión Planeación Viernes'); expect(card).toContain('Almuerzo Clientes Viernes');
    expect(card).not.toContain('Reunión Jueves'); expect(card).not.toContain('Reunión Lunes Próximo');
  });

  it('delivery offset preserves the primary and reuses the linked notice on repeat', async () => {
    const main: ReminderRow = { id: '11111111-1111-4111-8111-111111111111', user_id: user.id,
      content: 'Cita con el cliente', send_at: '2026-09-03T15:00:00Z', status: 'pending', acknowledged_at: null };
    state.rows = [main];
    const original = { ...main };
    const call = domainCall('advanceExisting');
    const input = { params: call.params, user, language: 'es', referenceTime };
    expect((await executeReminderUpdate(input)).success).toBe(true);
    expect(main).toEqual(original);
    expect(saveReminder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      parentReminderId: main.id, source: 'advance_notice', sendAt: '2026-09-03T14:45:00.000Z',
    }));
    expect((await executeReminderUpdate(input)).success).toBe(true);
    expect(saveReminder).toHaveBeenCalledTimes(1);
    expect(updateReminder).not.toHaveBeenCalled();
    expect(state.rows).toHaveLength(2);
    expect(main).toEqual(original);
  });
});
