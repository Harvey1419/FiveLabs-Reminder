import { describe, expect, it } from 'vitest';
import { normalizeTurnIntentForRuntime } from '../../../src/agent/orchestration/intent-normalizer.js';
import { resolveTypedSchedule } from '../../../src/agent/orchestration/typed-schedule.js';
import { normalizeAgendaScope, normalizeTaskScope, parseTaskScope } from '../../../src/shared/agenda-scopes.js';
import { formatCanonicalTaskList } from '../../../src/shared/agenda-presentation.js';
import { getMemoryEligibleText } from '../../../src/features/memory/service.js';

describe('core consistency hardening', () => {
  const context = {
    user: { id: 'consistency-user', phone_number: '573000000000' },
    referenceTime: new Date('2026-09-07T15:00:00.000Z'),
    timezone: 'America/Bogota',
  };

  it('canonicalizes agenda/task aliases at one boundary', () => {
    expect(normalizeAgendaScope('pendientes')).toBe('all_pending');
    expect(normalizeAgendaScope('rest-of-today')).toBe('remaining_today');
    expect(normalizeTaskScope('todos')).toBe('all_pending');
    expect(parseTaskScope('explicit_date@2026-09-09')).toEqual({
      scope: 'explicit_date',
      date: '2026-09-09',
      runtimeScope: 'explicit_date@2026-09-09',
    });
  });

  it('normalizes task temporal reads instead of silently broadening to all pending', () => {
    const normalized = normalizeTurnIntentForRuntime({
      actions: [{
        domain: 'task',
        action: 'list',
        schedule: { kind: 'relative_day_time', dayOffset: 0, hour: 10, minute: 0, clockMode: 'explicit_24h' },
      }],
    }, context);

    expect(normalized.actions[0].scope).toBe('today');
  });

  it('never converts an unresolved calendar identity reference into event content', () => {
    const normalized = normalizeTurnIntentForRuntime({
      actions: [{ domain: 'calendar', action: 'update', target: 'la segunda', description: 'Llevar muestras' }],
    }, context);

    expect(normalized.actions[0].target).toBe('la segunda');
    expect(normalized.actions[0].title).toBeUndefined();
    expect(normalized.actions[0].content).toBeUndefined();
    expect(normalized.actions[0].schedule).toBeUndefined();
  });

  it('treats inherit_context without cached time as a no-op patch instead of inventing a time', () => {
    const resolved = resolveTypedSchedule(
      { kind: 'inherit_context' },
      { referenceTime: context.referenceTime, timezone: context.timezone, baseDate: null },
    );

    expect(resolved.valid).toBe(true);
    expect(resolved.canonical).toBeNull();
    expect(resolved.inherited).toBe(false);
  });

  it('keeps Project -> tasks as the canonical collection hierarchy', () => {
    const card = formatCanonicalTaskList({
      scope: 'all_pending',
      timezone: 'America/Bogota',
      tasks: [
        { title: 'Primera', entityName: 'Reminder' },
        { title: 'Segunda', entityName: 'Reminder' },
      ],
    }, { language: 'es', timezone: 'America/Bogota' });

    expect(card).toContain('📁 *Reminder*\n1. Primera\n2. Segunda');
    expect(card).not.toContain('Primera\n📁 Reminder');
  });

  it('preserves durable residual facts in mixed operational turns', () => {
    const eligible = getMemoryEligibleText(
      'Recuérdame llamar a Pedro mañana. Trabajo en Globant.',
      [{
        tool: 'manage_reminder',
        card: '🔔 Recordatorio creado: llamar a Pedro mañana',
        summary: 'llamar a Pedro mañana',
      }],
    );

    expect(eligible).toContain('Trabajo en Globant');
    expect(eligible).not.toContain('Recuérdame llamar a Pedro mañana');
  });
});
