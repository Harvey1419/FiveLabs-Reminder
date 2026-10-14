import { describe, expect, it } from 'vitest';
import { normalizeAgendaScope, normalizeTaskScope, normalizeReminderScope, parseTaskScope, parseReminderScope, buildExplicitTaskDateScope, buildExplicitReminderDateScope, isAgendaScope, isTaskScope, isReminderScope, isAllPendingScope, AGENDA_SCOPES, TASK_SCOPES, REMINDER_SCOPES } from '../../../src/shared/read-scope-normalization.js';
describe('typed runtime read scopes', () => {
  it('normalizes bilingual aliases and separators without interpreting conversational commands', () => {
    expect(normalizeAgendaScope(' LO QUE QUEDA DE HOY ')).toBe('remaining_today');
    expect(normalizeTaskScope('pasado-mañana')).toBe('day_after_tomorrow');
    expect(normalizeReminderScope('miércoles')).toBe('wednesday');
    expect(normalizeAgendaScope('borra todo')).toBe('upcoming');
  });
  it('rejects inherited property names instead of returning an object or function', () => {
    for (const input of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(normalizeAgendaScope(input)).toBe('upcoming'); expect(normalizeAgendaScope(input, null)).toBeNull();
      expect(normalizeTaskScope(input)).toBe('all_pending'); expect(normalizeReminderScope(input)).toBe('upcoming');
      expect(isAllPendingScope(input)).toBe(false);
    }
  });
  it('retains domain-specific vocabulary and defaults for unknown filters', () => {
    expect(normalizeAgendaScope('month')).toBe('month'); expect(normalizeTaskScope('month')).toBe('all_pending');
    expect(normalizeReminderScope('completed_today')).toBe('completed_today'); expect(normalizeTaskScope('completados hoy')).toBe('all_pending');
    expect(normalizeReminderScope('CREADOS HOY')).toBe('created_today'); expect(normalizeAgendaScope(null, 'today')).toBe('today');
  });
  it('separates encoded local dates from runtime scope while preserving an explicit fallback', () => {
    expect(parseTaskScope('2031-01-14')).toEqual({ scope: 'explicit_date', date: '2031-01-14', runtimeScope: 'explicit_date@2031-01-14' });
    expect(parseReminderScope('explicit_date@2031-01-14')).toEqual({ scope: 'explicit_date', date: '2031-01-14', runtimeScope: 'explicit_date@2031-01-14' });
    expect(parseTaskScope('unknown', 'tomorrow')).toEqual({ scope: 'tomorrow', date: null, runtimeScope: 'tomorrow' });
    expect(parseReminderScope('unknown', null)).toEqual({ scope: null, date: null, runtimeScope: null });
  });
  it('validates date encoding shape and leaves calendar validity to temporal resolution', () => {
    expect(buildExplicitTaskDateScope('2031-1-14')).toBeNull(); expect(buildExplicitReminderDateScope('tomorrow')).toBeNull();
    expect(buildExplicitTaskDateScope('2031-99-99')).toBe('explicit_date@2031-99-99');
    expect(buildExplicitReminderDateScope(' 2031-01-14 ')).toBe('explicit_date@2031-01-14');
  });
  it('keeps membership predicates distinct from alias normalization and date conversion', () => {
    expect(normalizeTaskScope('2031-01-14')).toBe('explicit_date@2031-01-14'); expect(isTaskScope('2031-01-14')).toBe(false); expect(isTaskScope('explicit_date@2031-01-14')).toBe(true);
    expect(isAgendaScope('mañana')).toBe(false); expect(isReminderScope('mañana')).toBe(false); expect(isAllPendingScope('pendientes')).toBe(true);
    expect(Object.isFrozen(AGENDA_SCOPES)).toBe(true); expect(Object.isFrozen(TASK_SCOPES)).toBe(true); expect(Object.isFrozen(REMINDER_SCOPES)).toBe(true);
  });
});
