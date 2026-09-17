import { describe, it, expect } from 'vitest';
import { validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { resolveTypedSchedule } from '../../../src/agent/orchestration/typed-schedule.js';
import { mapToGoogleRRule } from '../../../src/integrations/google/calendar.js';
import { computeNextRecurringSendAt } from '../../../src/shared/reminder-recurrence.js';
import { formatRecurrenceLabel } from '../../../src/shared/reminder-presentation.js';
import { formatHumanFriendlyDate } from '../../../src/shared/time.js';

describe('All-Day Events & Yearly Recurrence Architecture', () => {
  describe('Contracts & Turn Intent Validation', () => {
    it('accepts calendar.create with allDay=true and null clock hour', () => {
      const intent = {
        actions: [
          {
            domain: 'calendar',
            action: 'create',
            title: 'Cumpleaños de mi amor',
            recurrence: 'yearly',
            schedule: {
              kind: 'calendar_date_time',
              month: 10,
              day: 14,
              year: 2026,
              hour: null,
              minute: null,
              allDay: true,
            },
          },
        ],
      };
      const res = validateTurnIntent(intent);
      expect(res.valid).toBe(true);
    });

    it('accepts calendar.create with yearly recurrence', () => {
      const intent = {
        actions: [
          {
            domain: 'calendar',
            action: 'create',
            title: 'Aniversario',
            recurrence: 'yearly',
            schedule: {
              kind: 'calendar_date_time',
              month: 5,
              day: 20,
              year: 2026,
              hour: 10,
              minute: 0,
            },
          },
        ],
      };
      const res = validateTurnIntent(intent);
      expect(res.valid).toBe(true);
    });

    it('accepts task.create with date-only schedule (null hour)', () => {
      const intent = {
        actions: [
          {
            domain: 'task',
            action: 'create',
            title: 'Entregar reporte anual',
            projectless: true,
            schedule: {
              kind: 'calendar_date_time',
              month: 12,
              day: 1,
              year: 2026,
              hour: null,
              minute: null,
              allDay: true,
            },
          },
        ],
      };
      const res = validateTurnIntent(intent);
      expect(res.valid).toBe(true);
    });

    it('infers missing time clarification for reminder.create without clock hour', () => {
      const intent = {
        actions: [
          {
            domain: 'reminder',
            action: 'create',
            content: 'Llamar al médico',
            schedule: {
              kind: 'calendar_date_time',
              month: 10,
              day: 14,
              year: 2026,
              hour: null,
              minute: null,
            },
          },
        ],
      };
      const res = validateTurnIntent(intent);
      expect(res.valid).toBe(true);
      expect(res.intent.actions[0].missingFields).toEqual(['time']);
    });

    it('rejects reminder.create without schedule', () => {
      const intent = {
        actions: [
          {
            domain: 'reminder',
            action: 'create',
            content: 'Llamar al médico',
          },
        ],
      };
      const res = validateTurnIntent(intent);
      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe('MISSING_SCHEDULE');
    });
  });

  describe('Typed Schedule Arithmetic (Anti-Midnight Policy)', () => {
    const referenceTime = new Date('2026-09-17T12:00:00.000Z');
    const timezone = 'America/Bogota';

    it('resolves all-day calendar_date_time with 9:00 AM anchor and canonicalDate', () => {
      const schedule = {
        kind: 'calendar_date_time',
        month: 10,
        day: 14,
        year: 2026,
        hour: null,
        minute: null,
      };
      const res = resolveTypedSchedule(schedule, { referenceTime, timezone });
      expect(res.valid).toBe(true);
      expect(res.isAllDay).toBe(true);
      expect(res.canonicalDate).toBe('2026-10-14');
      // In America/Bogota (UTC-5), 9:00 AM is 14:00:00 UTC
      expect(res.canonical).toBe('2026-10-14T14:00:00.000Z');
    });

    it('resolves all-day relative_day_time with 9:00 AM anchor', () => {
      const schedule = {
        kind: 'relative_day_time',
        dayOffset: 1,
        hour: null,
        minute: null,
      };
      const res = resolveTypedSchedule(schedule, { referenceTime, timezone });
      expect(res.valid).toBe(true);
      expect(res.isAllDay).toBe(true);
      expect(res.canonicalDate).toBe('2026-09-18');
      expect(res.canonical).toBe('2026-09-18T14:00:00.000Z');
    });

    it('preserves timed schedule with isAllDay=false and canonicalDate', () => {
      const schedule = {
        kind: 'calendar_date_time',
        month: 10,
        day: 14,
        year: 2026,
        hour: 15,
        minute: 30,
      };
      const res = resolveTypedSchedule(schedule, { referenceTime, timezone });
      expect(res.valid).toBe(true);
      expect(res.isAllDay).toBe(false);
      expect(res.canonicalDate).toBe('2026-10-14');
      // 15:30 in UTC-5 is 20:30 UTC
      expect(res.canonical).toBe('2026-10-14T20:30:00.000Z');
    });
  });

  describe('Google Calendar RRULE Mapping', () => {
    it('maps yearly and annual to RRULE:FREQ=YEARLY', () => {
      expect(mapToGoogleRRule('yearly')).toBe('RRULE:FREQ=YEARLY');
      expect(mapToGoogleRRule('annual')).toBe('RRULE:FREQ=YEARLY');
    });

    it('maps monthly, weekly, daily and weekdays correctly', () => {
      expect(mapToGoogleRRule('monthly')).toBe('RRULE:FREQ=MONTHLY');
      expect(mapToGoogleRRule('weekly')).toBe('RRULE:FREQ=WEEKLY');
      expect(mapToGoogleRRule('daily')).toBe('RRULE:FREQ=DAILY');
      expect(mapToGoogleRRule('weekdays')).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    });

    it('returns null for unknown rules', () => {
      expect(mapToGoogleRRule('unknown')).toBeNull();
      expect(mapToGoogleRRule(null)).toBeNull();
    });
  });

  describe('Reminder Recurrence Engine (Yearly)', () => {
    it('advances exactly one year for yearly rule', () => {
      const start = new Date('2026-10-14T14:00:00.000Z');
      const now = new Date('2026-10-15T00:00:00.000Z');
      const next = computeNextRecurringSendAt(start, 'yearly', now);
      expect(next).not.toBeNull();
      expect(next.toISOString()).toBe('2027-10-14T14:00:00.000Z');
    });

    it('advances exactly one year for annual rule', () => {
      const start = new Date('2026-05-01T14:00:00.000Z');
      const now = new Date('2026-05-02T00:00:00.000Z');
      const next = computeNextRecurringSendAt(start, 'annual', now);
      expect(next).not.toBeNull();
      expect(next.toISOString()).toBe('2027-05-01T14:00:00.000Z');
    });

    it('advances multiple years if reference time has passed multiple cycles', () => {
      const start = new Date('2024-10-14T14:00:00.000Z');
      const now = new Date('2026-09-17T00:00:00.000Z');
      const next = computeNextRecurringSendAt(start, 'yearly', now);
      expect(next).not.toBeNull();
      expect(next.toISOString()).toBe('2026-10-14T14:00:00.000Z');
    });
  });

  describe('Presentation Labels & Formatting', () => {
    it('formats yearly recurrence label in Spanish and English', () => {
      expect(formatRecurrenceLabel('yearly', 'es')).toBe('Todos los años');
      expect(formatRecurrenceLabel('annual', 'es')).toBe('Todos los años');
      expect(formatRecurrenceLabel('yearly', 'en')).toBe('Every year');
      expect(formatRecurrenceLabel('annual', 'en')).toBe('Every year');
    });

    it('formats date-only friendly representation without clock', () => {
      const date = new Date('2026-10-14T14:00:00.000Z');
      const formattedEs = formatHumanFriendlyDate(date, 'America/Bogota', 'es');
      expect(formattedEs.toLowerCase()).toContain('14 de octubre');
      expect(formattedEs).not.toContain(':'); // No clock time
    });
  });
});
