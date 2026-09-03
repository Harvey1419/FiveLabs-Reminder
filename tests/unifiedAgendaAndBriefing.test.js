import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeTool } from '../src/ai/tools.js';
import { getUnifiedAgenda, formatUnifiedAgendaCard } from '../src/services/unifiedAgendaService.js';
import { formatMorningBriefingMessage } from '../src/workers/morningBriefing.js';
import { formatReminderListCard } from '../src/ai/tools/formatters.js';
import * as googleService from '../src/services/googleCalendar.js';
import * as integrationsDb from '../src/db/integrations.js';
import * as db from '../src/db/index.js';
import { supabase } from '../src/db/index.js';

function createFluentQueryMock(resolveData) {
  const queryObj = {
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

describe('Unified Agenda & Morning Briefing Test Suite', () => {
  const testUser = {
    id: 'test-unified-user-uuid',
    phone_number: '573009998877',
    timezone: 'America/Bogota',
    locale: 'es-CO',
    is_admin: false,
    isPro: true,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Unified Agenda Aggregation (get_unified_agenda)', () => {
    it('should aggregate Calendar + Reminders + Tasks in parallel for tomorrow', async () => {
      vi.spyOn(integrationsDb, 'getUserIntegration').mockResolvedValue({
        access_token: 'valid-token',
        account_email: 'test@gmail.com',
      });
      vi.spyOn(googleService, 'listCalendarEvents').mockResolvedValue([
        {
          id: 'g-event-1',
          summary: 'Cita médica',
          start: { dateTime: '2026-09-03T08:00:00-05:00' },
          end: { dateTime: '2026-09-03T09:00:00-05:00' },
        },
      ]);

      const mockTomorrow = '2026-09-03T13:00:00.000Z';
      const mockReminders = [
        {
          id: 'rem-uuid-1',
          content: 'Recordatorio diario: Eres muy importante',
          send_at: mockTomorrow,
          recurrence_rule: 'daily',
          status: 'pending',
          acknowledged_at: null,
        },
      ];
      const mockTasks = [
        {
          id: 'task-uuid-1',
          title: 'Revisar informe mensual',
          due_date: mockTomorrow,
          status: 'pending',
          entities: { name: 'Trabajo' },
        },
      ];

      vi.spyOn(supabase, 'from').mockImplementation(table => {
        if (table === 'reminders') return createFluentQueryMock(mockReminders);
        if (table === 'tasks') return createFluentQueryMock(mockTasks);
        return createFluentQueryMock([]);
      });

      const res = await executeTool(
        'get_unified_agenda',
        { scope: 'tomorrow' },
        testUser
      );

      expect(res.success).toBe(true);
      expect(res.action).toBe('unified_agenda_listed');
      expect(res.data.calendar.state).toBe('CONNECTED');
      expect(res.data.calendar.events.length).toBe(1);
      expect(res.data.reminders.length).toBe(1);
      expect(res.data.tasks.length).toBe(1);

      // Verify card content
      expect(res.rawSummary).toContain('CALENDARIO');
      expect(res.rawSummary).toContain('Cita médica');
      expect(res.rawSummary).toContain('RECORDATORIOS');
      expect(res.rawSummary).toContain('Recordatorio diario: Eres muy importante');
      expect(res.rawSummary).toContain('TAREAS');
      expect(res.rawSummary).toContain('Revisar informe mensual');
      expect(res.rawSummary).not.toContain('[id:');
      expect(res.rawSummary).not.toContain('(ref:');
    });

    it('should aggregate Calendar + Reminders + Tasks in parallel for this_week', async () => {
      vi.spyOn(integrationsDb, 'getUserIntegration').mockResolvedValue({
        access_token: 'valid-token',
        account_email: 'test@gmail.com',
      });
      vi.spyOn(googleService, 'listCalendarEvents').mockResolvedValue([
        {
          id: 'g-event-2',
          summary: 'Sprint Planning',
          start: { dateTime: '2026-09-04T10:00:00-05:00' },
          end: { dateTime: '2026-09-04T11:00:00-05:00' },
        },
      ]);

      const mockFriday = '2026-09-04T15:00:00.000Z';
      const mockReminders = [
        {
          id: 'rem-uuid-week',
          content: 'Pagar nómina',
          send_at: mockFriday,
          status: 'pending',
          acknowledged_at: null,
        },
      ];

      vi.spyOn(supabase, 'from').mockImplementation(table => {
        if (table === 'reminders') return createFluentQueryMock(mockReminders);
        if (table === 'tasks') return createFluentQueryMock([]);
        return createFluentQueryMock([]);
      });

      const res = await executeTool(
        'get_unified_agenda',
        { scope: 'this_week' },
        testUser
      );

      expect(res.success).toBe(true);
      expect(res.data.calendar.events.length).toBe(1);
      expect(res.data.reminders.length).toBe(1);
      expect(res.rawSummary).toContain('Sprint Planning');
      expect(res.rawSummary).toContain('Pagar nómina');
    });

    it('should deliver Reminders and Tasks cleanly when Calendar is DISCONNECTED without failing', async () => {
      vi.spyOn(integrationsDb, 'getUserIntegration').mockResolvedValue(null);

      const mockTomorrow = '2026-09-03T13:00:00.000Z';
      const mockReminders = [
        {
          id: 'rem-uuid-2',
          content: 'Comprar vendaje',
          send_at: mockTomorrow,
          status: 'pending',
          acknowledged_at: null,
        },
      ];

      vi.spyOn(supabase, 'from').mockImplementation(table => {
        if (table === 'reminders') return createFluentQueryMock(mockReminders);
        if (table === 'tasks') return createFluentQueryMock([]);
        return createFluentQueryMock([]);
      });

      const res = await executeTool(
        'get_unified_agenda',
        { scope: 'tomorrow' },
        testUser
      );

      expect(res.success).toBe(true);
      expect(res.data.calendar.state).toBe('DISCONNECTED');
      expect(res.data.reminders.length).toBe(1);
      expect(res.rawSummary).toContain('RECORDATORIOS');
      expect(res.rawSummary).toContain('Comprar vendaje');
    });

    it('should deliver Reminders and Tasks cleanly when Calendar has an API ERROR without crashing', async () => {
      vi.spyOn(integrationsDb, 'getUserIntegration').mockResolvedValue({
        access_token: 'valid-token',
      });
      vi.spyOn(googleService, 'listCalendarEvents').mockRejectedValue(new Error('Google 503 Service Unavailable'));

      const mockTomorrow = '2026-09-03T13:00:00.000Z';
      const mockReminders = [
        { id: 'rem-3', content: 'Llamar al banco', send_at: mockTomorrow, status: 'pending', acknowledged_at: null },
      ];

      vi.spyOn(supabase, 'from').mockImplementation(table => {
        if (table === 'reminders') return createFluentQueryMock(mockReminders);
        if (table === 'tasks') return createFluentQueryMock([]);
        return createFluentQueryMock([]);
      });

      const res = await executeTool(
        'get_unified_agenda',
        { scope: 'tomorrow' },
        testUser
      );

      expect(res.success).toBe(true);
      expect(res.data.calendar.state).toBe('ERROR');
      expect(res.data.reminders.length).toBe(1);
      expect(res.rawSummary).toContain('Llamar al banco');
    });

    it('should report zero events honestly without inventing content when all 3 domains are empty', async () => {
      vi.spyOn(integrationsDb, 'getUserIntegration').mockResolvedValue({
        access_token: 'valid-token',
      });
      vi.spyOn(googleService, 'listCalendarEvents').mockResolvedValue([]);

      vi.spyOn(supabase, 'from').mockImplementation(() => createFluentQueryMock([]));

      const res = await executeTool(
        'get_unified_agenda',
        { scope: 'tomorrow' },
        testUser
      );

      expect(res.success).toBe(true);
      expect(res.data.calendar.events.length).toBe(0);
      expect(res.data.reminders.length).toBe(0);
      expect(res.data.tasks.length).toBe(0);
      expect(res.rawSummary).toContain('No tienes eventos');
    });
  });

  describe('2. Morning Briefing Integration with Google Calendar', () => {
    it('should include Google Calendar section in briefing when connected and has events', () => {
      const overview = {
        timedRemindersToday: [
          { content: 'Reunión semanal', localTime: '10:00 AM' },
        ],
        tasksDueToday: [],
        openTasksByEntity: {},
        openTasksGeneral: [],
      };

      const calendar = {
        state: 'CONNECTED',
        events: [
          { summary: 'Desayuno con cliente', localStartTime: '08:30 AM', isAllDay: false },
        ],
      };

      const message = formatMorningBriefingMessage({
        overview,
        calendar,
        timezone: 'America/Bogota',
      });

      expect(message).toContain('Compromisos en Google Calendar');
      expect(message).toContain('Desayuno con cliente');
      expect(message).toContain('Compromisos con hora fija');
      expect(message).toContain('Reunión semanal');
    });

    it('should continue briefing normally when Google Calendar is DISCONNECTED without error', () => {
      const overview = {
        timedRemindersToday: [
          { content: 'Tomar vitamina', localTime: '08:00 AM' },
        ],
        tasksDueToday: [
          { title: 'Enviar reporte', localTime: '05:00 PM' },
        ],
        openTasksByEntity: {},
        openTasksGeneral: [],
      };

      const calendar = {
        state: 'DISCONNECTED',
        events: [],
      };

      const message = formatMorningBriefingMessage({
        overview,
        calendar,
        timezone: 'America/Bogota',
      });

      expect(message).not.toContain('Compromisos en Google Calendar');
      expect(message).toContain('Tomar vitamina');
      expect(message).toContain('Enviar reporte');
    });

    it('should note temporary calendar unavailability gracefully without breaking briefing on ERROR', () => {
      const overview = {
        timedRemindersToday: [
          { content: 'Revisar métricas', localTime: '09:00 AM' },
        ],
        tasksDueToday: [],
        openTasksByEntity: {},
        openTasksGeneral: [],
      };

      const calendar = {
        state: 'ERROR',
        events: [],
      };

      const message = formatMorningBriefingMessage({
        overview,
        calendar,
        timezone: 'America/Bogota',
      });

      expect(message).toContain('Revisar métricas');
      expect(message).toContain('Google Calendar');
    });
  });

  describe('3. Deterministic Acknowledge & Ambiguity Guard', () => {
    it('should acknowledge unique matching reminder by natural keyword (e.g. veterinaria) and persist in DB', async () => {
      const pendingBorona = {
        id: 'e64c5e4b-1bf6-45b9-9886-528dad61ab58',
        phone_number: '573009998877',
        user_id: 'test-unified-user-uuid',
        content: 'Escribirle a la veterinaria para comprarle más vendaje a Borona',
        requires_confirmation: true,
        status: 'sent',
        acknowledged_at: null,
      };

      vi.spyOn(supabase, 'from').mockImplementation(table => {
        if (table === 'reminders') return createFluentQueryMock([pendingBorona]);
        return createFluentQueryMock([]);
      });

      vi.spyOn(db, 'acknowledgeReminder').mockResolvedValue({
        ...pendingBorona,
        acknowledged_at: new Date().toISOString(),
      });

      const res = await executeTool(
        'manage_reminder',
        { action: 'acknowledge', query: 'veterinaria' },
        testUser
      );

      expect(res.success).toBe(true);
      expect(res.action).toBe('acknowledged_reminder');
      expect(res.rawSummary).toContain('confirmado');
      expect(res.rawSummary).not.toContain('[id:');
    });

    it('should NOT mutate DB when multiple ambiguous candidate reminders match query and return AMBIGUOUS_TARGET', async () => {
      const candidateA = {
        id: 'aaa-111',
        content: 'Escribirle a la veterinaria para el vendaje',
        status: 'pending',
        acknowledged_at: null,
      };
      const candidateB = {
        id: 'bbb-222',
        content: 'Escribirle a la veterinaria para la cita de vacunas',
        status: 'pending',
        acknowledged_at: null,
      };

      vi.spyOn(supabase, 'from').mockImplementation(table => {
        if (table === 'reminders') return createFluentQueryMock([candidateA, candidateB]);
        return createFluentQueryMock([]);
      });

      const ackSpy = vi.spyOn(db, 'acknowledgeReminder');

      const res = await executeTool(
        'manage_reminder',
        { action: 'acknowledge', query: 'veterinaria' },
        testUser
      );

      expect(res.success).toBe(false);
      expect(res.action).toBe('ambiguous_target');
      expect(res.errorCode).toBe('AMBIGUOUS_TARGET');
      expect(ackSpy).not.toHaveBeenCalled();
    });

    it('should format clean reminder list card without internal IDs', () => {
      const reminders = [
        {
          id: 'e64c5e4b-1234',
          content: 'Escribirle a la veterinaria',
          send_at: '2026-09-03T13:00:00Z',
          requires_confirmation: true,
        },
      ];

      const card = formatReminderListCard(reminders, 'America/Bogota', 'es');
      expect(card).toContain('Escribirle a la veterinaria');
      expect(card).not.toContain('e64c5e4b');
      expect(card).not.toContain('[id:');
      expect(card).not.toContain('(ref:');
    });
  });

  describe('4. Domain & Entity Independence', () => {
    it('should keep calendar events, reminders, and tasks as separate decoupled types', async () => {
      vi.spyOn(integrationsDb, 'getUserIntegration').mockResolvedValue({
        access_token: 'valid-token',
        account_email: 'test@gmail.com',
      });
      vi.spyOn(googleService, 'listCalendarEvents').mockResolvedValue([
        {
          id: 'g-event-sep',
          summary: 'Reunión de Diseño',
          start: { dateTime: '2026-09-03T10:00:00-05:00' },
          end: { dateTime: '2026-09-03T11:00:00-05:00' },
        },
      ]);

      const mockTomorrow = '2026-09-03T15:00:00.000Z';
      vi.spyOn(supabase, 'from').mockImplementation(table => {
        if (table === 'reminders') {
          return createFluentQueryMock([
            { id: 'rem-sep', content: 'Llamar a cliente', send_at: mockTomorrow, status: 'pending', acknowledged_at: null },
          ]);
        }
        if (table === 'tasks') {
          return createFluentQueryMock([
            { id: 'task-sep', title: 'Completar wireframe', due_date: mockTomorrow, status: 'pending' },
          ]);
        }
        return createFluentQueryMock([]);
      });

      const res = await getUnifiedAgenda({
        userId: testUser.id,
        phoneNumber: testUser.phone_number,
        timezone: testUser.timezone,
        scope: 'tomorrow',
      });

      expect(res.calendar.events[0].type).toBe('calendar_event');
      expect(res.reminders[0].type).toBe('reminder');
      expect(res.tasks[0].type).toBe('task');
    });
  });
});
