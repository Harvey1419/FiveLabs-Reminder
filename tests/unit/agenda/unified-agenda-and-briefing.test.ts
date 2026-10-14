import { untrustedResultMock } from '../../support/unit/contract-boundary.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeTool } from '../../../src/agent/tools/index.js';
import { getUnifiedAgenda } from '../../../src/features/agenda/service.js';
import { formatCanonicalAgenda } from '../../../src/shared/agenda-presentation.js';
import { formatCanonicalReminderList } from '../../../src/shared/reminder-presentation.js';
import { formatMorningBriefingMessage } from '../../../src/jobs/morning-briefing.js';
import * as googleService from '../../../src/integrations/google/calendar.js';
import * as integrationsDb from '../../../src/infrastructure/database/integrations.js';
import * as db from '../../../src/infrastructure/database/index.js';
import { supabase } from '../../../src/infrastructure/database/index.js';

type QueryResult<T> = { data: T | null; error: unknown };
type Query<T> = { [K in 'select' | 'neq' | 'is' | 'gte' | 'lt' | 'eq' | 'or' | 'order' | 'limit' | 'update']: (...args: unknown[]) => Query<T> } & PromiseLike<QueryResult<T>> & {
  single(): Promise<QueryResult<unknown>>; maybeSingle(): Promise<QueryResult<unknown>>;
};
function createFluentQueryMock<T>(resolveData: T): Query<T> {
  const queryObj: Query<T> = {
    select: () => queryObj,
    neq: () => queryObj,
    is: () => queryObj,
    gte: () => queryObj,
    lt: () => queryObj,
    eq: () => queryObj,
    or: () => queryObj,
    order: () => queryObj,
    limit: () => queryObj,
    update: () => queryObj,
    single: () => Promise.resolve({ data: Array.isArray(resolveData) ? resolveData[0] : resolveData, error: null }),
    maybeSingle: () => Promise.resolve({ data: Array.isArray(resolveData) ? resolveData[0] : resolveData, error: null }),
    then: (resolve, reject) => Promise.resolve({ data: resolveData, error: null }).then(resolve, reject),
  };
  return queryObj;
}

function renderAgenda(data: { timezone?: string; [field: string]: unknown }) {
  return formatCanonicalAgenda(data, {
    language: 'es',
    timezone: data.timezone || 'America/Bogota',
  });
}

type ToolResult = Awaited<ReturnType<typeof executeTool>>;
type AgendaData = Awaited<ReturnType<typeof getUnifiedAgenda>>;
type CanonicalResult<N extends string> = ToolResult & { data: N extends 'get_unified_agenda' ? AgendaData : unknown };
function executeCanonical<N extends string>(toolName: N, params: NonNullable<Parameters<typeof executeTool>[1]>, user: NonNullable<Parameters<typeof executeTool>[2]>): Promise<CanonicalResult<N>> {
  // Test inspections below assert the selected domain's data without rewriting the real result.
  return executeTool({ toolName, params, user, language: 'es' }) as Promise<CanonicalResult<N>>;
}

describe('Unified Agenda & Morning Briefing', () => {
  const testUser = {
    id: 'test-unified-user-uuid',
    phone_number: '573009998877',
    timezone: 'America/Bogota',
    locale: 'es-CO',
    is_admin: false,
    isPro: true,
  };

  beforeEach(() => vi.restoreAllMocks());

  describe('Unified Agenda structured truth + canonical presentation', () => {
    it('aggregates Calendar + Reminders + Tasks and renders them only at presentation boundary', async () => {
      vi.mocked(vi.spyOn(integrationsDb, 'getUserIntegration'), { partial: true }).mockResolvedValue({ access_token: 'valid-token', account_email: 'test@gmail.com' });
      untrustedResultMock(vi.spyOn(googleService, 'listCalendarEvents')).mockResolvedValue([{
        id: 'g-event-1', summary: 'Cita médica',
        start: { dateTime: '2026-09-03T08:00:00-05:00' },
        end: { dateTime: '2026-09-03T09:00:00-05:00' },
      }]);

      const mockTomorrow = '2026-09-03T13:00:00.000Z';
      untrustedResultMock(vi.spyOn(supabase, 'from')).mockImplementation((table) => {
        if (table === 'reminders') return createFluentQueryMock([{
          id: 'rem-1', content: 'Recordatorio diario', send_at: mockTomorrow,
          recurrence_rule: 'daily', status: 'pending', acknowledged_at: null,
        }]);
        if (table === 'tasks') return createFluentQueryMock([{
          id: 'task-1', title: 'Revisar informe mensual', due_date: mockTomorrow,
          status: 'pending', entities: { name: 'Trabajo' },
        }]);
        return createFluentQueryMock([]);
      });

      const res = await executeCanonical('get_unified_agenda', { scope: 'tomorrow' }, testUser);
      expect(res.success).toBe(true);
      expect(res.data.calendar.events).toHaveLength(1);
      expect(res.data.reminders).toHaveLength(1);
      expect(res.data.tasks).toHaveLength(1);
      expect(res.rawSummary).toBe('Agenda consultada.');

      const card = renderAgenda(res.data);
      expect(card).toContain('Cita médica');
      expect(card).toContain('Recordatorio diario');
      expect(card).toContain('📁 *Trabajo*\n1. Revisar informe mensual');
      expect(card).not.toContain('[id:');
    });

    it('keeps useful domains available when Google Calendar is disconnected', async () => {
      vi.mocked(vi.spyOn(integrationsDb, 'getUserIntegration'), { partial: true }).mockResolvedValue(null);
      const mockTomorrow = '2026-09-03T13:00:00.000Z';
      untrustedResultMock(vi.spyOn(supabase, 'from')).mockImplementation((table) => {
        if (table === 'reminders') return createFluentQueryMock([{
          id: 'rem-2', content: 'Comprar vendaje', send_at: mockTomorrow,
          status: 'pending', acknowledged_at: null,
        }]);
        return createFluentQueryMock([]);
      });

      const res = await executeCanonical('get_unified_agenda', { scope: 'tomorrow' }, testUser);
      const card = renderAgenda(res.data);
      expect(res.data.calendar.state).toBe('DISCONNECTED');
      expect(card).toContain('🔒 No conectado');
      expect(card).toContain('Comprar vendaje');
    });

    it('reports Google errors without hiding reminders or fabricating events', async () => {
      vi.mocked(vi.spyOn(integrationsDb, 'getUserIntegration'), { partial: true }).mockResolvedValue({ access_token: 'valid-token' });
      untrustedResultMock(vi.spyOn(googleService, 'listCalendarEvents')).mockRejectedValue(new Error('Google 503'));
      const mockTomorrow = '2026-09-03T13:00:00.000Z';
      untrustedResultMock(vi.spyOn(supabase, 'from')).mockImplementation((table) => {
        if (table === 'reminders') return createFluentQueryMock([{
          id: 'rem-3', content: 'Llamar al banco', send_at: mockTomorrow,
          status: 'pending', acknowledged_at: null,
        }]);
        return createFluentQueryMock([]);
      });

      const res = await executeCanonical('get_unified_agenda', { scope: 'tomorrow' }, testUser);
      const card = renderAgenda(res.data);
      expect(res.data.calendar.state).toBe('ERROR');
      expect(card).toContain('No disponible temporalmente');
      expect(card).toContain('Llamar al banco');
    });

    it('represents an empty connected agenda honestly', async () => {
      vi.mocked(vi.spyOn(integrationsDb, 'getUserIntegration'), { partial: true }).mockResolvedValue({ access_token: 'valid-token' });
      untrustedResultMock(vi.spyOn(googleService, 'listCalendarEvents')).mockResolvedValue([]);
      untrustedResultMock(vi.spyOn(supabase, 'from')).mockImplementation(() => createFluentQueryMock([]));

      const res = await executeCanonical('get_unified_agenda', { scope: 'tomorrow' }, testUser);
      const card = renderAgenda(res.data);
      expect(res.data.calendar.events).toHaveLength(0);
      expect(res.data.reminders).toHaveLength(0);
      expect(res.data.tasks).toHaveLength(0);
      expect(card).toContain('Sin eventos en este período');
      expect(card).toContain('No encontré pendientes en este período');
    });
  });

  describe('Morning Briefing integration', () => {
    it('includes connected Calendar events and timed reminders', () => {
      const message = formatMorningBriefingMessage({
        overview: {
          timedRemindersToday: [{ content: 'Reunión semanal', localTime: '10:00 AM' }],
          tasksDueToday: [], openTasksByEntity: {}, openTasksGeneral: [],
        },
        calendar: {
          state: 'CONNECTED',
          events: [{ summary: 'Desayuno con cliente', localStartTime: '08:30 AM', isAllDay: false }],
        },
        timezone: 'America/Bogota',
      });
      expect(message).toContain('Desayuno con cliente');
      expect(message).toContain('Reunión semanal');
    });

    it('continues when Calendar is disconnected', () => {
      const message = formatMorningBriefingMessage({
        overview: {
          timedRemindersToday: [{ content: 'Tomar vitamina', localTime: '08:00 AM' }],
          tasksDueToday: [{ title: 'Enviar reporte', localTime: '05:00 PM' }],
          openTasksByEntity: {}, openTasksGeneral: [],
        },
        calendar: { state: 'DISCONNECTED', events: [] },
        timezone: 'America/Bogota',
      });
      expect(message).toContain('Tomar vitamina');
      expect(message).toContain('Enviar reporte');
    });
  });

  describe('Deterministic acknowledge & domain separation', () => {
    it('acknowledges a unique matching reminder and keeps IDs out of presentation', async () => {
      const reminder = {
        id: 'e64c5e4b-1bf6-45b9-9886-528dad61ab58',
        phone_number: testUser.phone_number,
        user_id: testUser.id,
        content: 'Escribirle a la veterinaria para comprar vendaje',
        requires_confirmation: true,
        status: 'sent', acknowledged_at: null,
      };
      untrustedResultMock(vi.spyOn(supabase, 'from')).mockImplementation((table) => table === 'reminders'
        ? createFluentQueryMock([reminder]) : createFluentQueryMock([]));
      vi.spyOn(db, 'acknowledgeReminder').mockResolvedValue({ ...reminder, acknowledged_at: new Date().toISOString() });

      const res = await executeCanonical('manage_reminder', { action: 'acknowledge', target: 'veterinaria' }, testUser);
      expect(res.success).toBe(true);
      expect(res.rawSummary).not.toContain(reminder.id);
    });

    it('keeps calendar events, reminders and tasks as separate structured types', async () => {
      vi.mocked(vi.spyOn(integrationsDb, 'getUserIntegration'), { partial: true }).mockResolvedValue({ access_token: 'valid-token' });
      untrustedResultMock(vi.spyOn(googleService, 'listCalendarEvents')).mockResolvedValue([{
        id: 'g-event-sep', summary: 'Reunión de Diseño',
        start: { dateTime: '2026-09-03T10:00:00-05:00' }, end: { dateTime: '2026-09-03T11:00:00-05:00' },
      }]);
      const time = '2026-09-03T15:00:00.000Z';
      untrustedResultMock(vi.spyOn(supabase, 'from')).mockImplementation((table) => {
        if (table === 'reminders') return createFluentQueryMock([{ id: 'r', content: 'Llamar', send_at: time, status: 'pending', acknowledged_at: null }]);
        if (table === 'tasks') return createFluentQueryMock([{ id: 't', title: 'Wireframe', due_date: time, status: 'pending' }]);
        return createFluentQueryMock([]);
      });

      const data = await getUnifiedAgenda({ userId: testUser.id, phoneNumber: testUser.phone_number, timezone: testUser.timezone, scope: 'tomorrow' });
      expect(data.calendar.events[0]!.type).toBe('calendar_event');
      expect(data.reminders[0]!.type).toBe('reminder');
      expect(data.tasks[0]!.type).toBe('task');
    });

    it('keeps the standalone canonical reminder list free of internal IDs', () => {
      const card = formatCanonicalReminderList({
        reminders: [{
          id: 'internal-id', content: 'Escribirle a la veterinaria',
          send_at: '2026-09-03T13:00:00Z', requires_confirmation: true,
        }],
      }, { language: 'es', timezone: 'America/Bogota' });
      expect(card).toContain('Escribirle a la veterinaria');
      expect(card).not.toContain('internal-id');
    });
  });
});

describe('partial agenda evidence', () => {
  it('does not present a failed task read as an empty agenda', async () => {
    vi.mocked(vi.spyOn(integrationsDb, 'getUserIntegration'), { partial: true }).mockResolvedValue({ access_token: 'token' });
    untrustedResultMock(vi.spyOn(googleService, 'listCalendarEvents')).mockResolvedValue([]);
    untrustedResultMock(vi.spyOn(supabase, 'from')).mockImplementation(table => {
      const query = createFluentQueryMock([]);
      if (table === 'tasks') query.then = (resolve, reject) => Promise.resolve<QueryResult<never[]>>({ data: null, error: { message: 'read failed' } }).then(resolve, reject);
      return query;
    });
    const agenda = await getUnifiedAgenda({ userId: 'u1', scope: 'tomorrow' });
    expect(agenda.complete).toBe(false);
    expect(agenda.sources.tasks).toBe('ERROR');
    const card = renderAgenda(agenda);
    expect(card).toContain('Tareas: no disponibles');
    expect(card).toContain('puede estar incompleta');
    expect(card).not.toContain('No encontré pendientes en este período');
    vi.restoreAllMocks();
  });
  it('does not declare a free day when Calendar is unavailable', () => {
    const card = renderAgenda({ scope: 'tomorrow', calendar: { state: 'ERROR', events: [] }, tasks: [], reminders: [] });
    expect(card).toContain('puede estar incompleta');
    expect(card).not.toContain('Día completamente libre');
  });
});
