import { afterEach, describe, expect, it } from 'vitest';
import { normalizeTurnIntentForRuntime } from '../../../src/agent/orchestration/intent-normalizer.js';
import { saveWorkingMemory, clearWorkingMemory } from '../../../src/agent/core/working-memory.js';

const user = {
  id: 'user-recurring-update',
  phone_number: '573009998877',
  timezone: 'America/Bogota',
};

afterEach(() => clearWorkingMemory(user));

describe('recurring reminder runtime normalization', () => {
  it('preserves the future occurrence date when changing only a daily reminder clock', () => {
    saveWorkingMemory(user, {
      source: 'reminder',
      items: [{
        id: '11111111-1111-4111-8111-111111111111',
        type: 'reminder',
        summary: 'Me amo mucho',
        time: '2026-09-09T13:00:00.000Z',
        raw: {
          id: '11111111-1111-4111-8111-111111111111',
          content: 'Me amo mucho',
          recurrence_rule: 'daily',
          send_at: '2026-09-09T13:00:00.000Z',
        },
      }],
    });

    const result = normalizeTurnIntentForRuntime({
      actions: [{
        domain: 'reminder',
        action: 'update',
        target: 'Me amo mucho',
        schedule: { kind: 'local_time', hour: 8, minute: 0, clockMode: 'explicit_am' },
      }],
    }, {
      user,
      timezone: 'America/Bogota',
      referenceTime: new Date('2026-09-08T00:04:00.000Z'),
    });

    expect(result.actions[0].schedule).toMatchObject({
      kind: 'local_time',
      hour: 8,
      minute: 0,
    });
  });

  it('keeps today when the daily recurring clock time is still in the future', () => {
    const result = normalizeTurnIntentForRuntime({
      actions: [{
        domain: 'reminder',
        action: 'create',
        content: 'Tomar agua',
        recurrence: 'daily',
        schedule: { kind: 'local_time', hour: 8, minute: 0, clockMode: 'explicit_am' },
      }],
    }, {
      user,
      timezone: 'America/Bogota',
      referenceTime: new Date('2026-09-07T12:00:00.000Z'),
    });

    expect(result.actions[0].schedule).toMatchObject({ kind: 'local_time', hour: 8, minute: 0 });
  });

  it('never lets active reminder Working Memory turn explicit composed creates into updates', () => {
    saveWorkingMemory(user, {
      source: 'reminder',
      lastAction: 'manage_reminder',
      items: [{
        id: '22222222-2222-4222-8222-222222222222',
        type: 'reminder',
        summary: 'cita',
        time: '2026-09-08T21:00:00.000Z',
        raw: {
          id: '22222222-2222-4222-8222-222222222222',
          content: 'cita',
          send_at: '2026-09-08T21:00:00.000Z',
        },
      }],
    });

    const intent = {
      actions: [
        {
          domain: 'reminder', action: 'create', content: 'Tomar las vitaminas', recurrence: 'daily',
          schedule: { kind: 'local_time', hour: 7, minute: 30, clockMode: 'explicit_am' },
        },
        {
          domain: 'reminder', action: 'create', content: 'Preparar la ropa del día siguiente', recurrence: 'daily',
          schedule: { kind: 'local_time', hour: 21, minute: 0, clockMode: 'explicit_pm' },
        },
        {
          domain: 'reminder', action: 'create', content: 'Llamar al veterinario', advanceMinutes: 30,
          schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 10, minute: 15, clockMode: 'explicit_am' },
        },
        {
          domain: 'reminder', action: 'create', content: 'Revisar el presupuesto del apartamento',
          schedule: { kind: 'weekday_time', weekday: 'friday', hour: 15, minute: 0, clockMode: 'explicit_pm' },
        },
        {
          domain: 'reminder', action: 'create', content: 'Revisar mis pendientes de la semana', recurrence: 'weekly',
          schedule: { kind: 'weekday_time', weekday: 'monday', hour: 8, minute: 0, clockMode: 'explicit_am' },
        },
      ],
    };

    const result = normalizeTurnIntentForRuntime(intent, {
      user,
      timezone: 'America/Bogota',
      referenceTime: new Date('2026-09-08T20:28:00.000Z'),
    });

    expect(result.actions).toHaveLength(5);
    expect(result.actions.every((action) => action.domain === 'reminder' && action.action === 'create')).toBe(true);
    expect(result.actions.every((action) => action.target == null)).toBe(true);
    expect(result.actions[2].schedule).toMatchObject({
      kind: 'relative_day_time', dayOffset: 1, hour: 10, minute: 15,
    });
  });

  it('normalizes reminder.list scope and filter dynamically', () => {
    const intent = {
      actions: [
        { domain: 'reminder', action: 'list', scope: 'tomorrow' },
        { domain: 'reminder', action: 'list', filter: 'mañana' },
        { domain: 'reminder', action: 'list', scope: 'martes' },
      ],
    };

    const result = normalizeTurnIntentForRuntime(intent, {
      user,
      timezone: 'America/Bogota',
      referenceTime: new Date('2026-09-08T20:28:00.000Z'),
    });

    expect(result.actions[0]).toMatchObject({
      domain: 'reminder',
      action: 'list',
      filter: 'tomorrow',
      scope: 'tomorrow',
    });
    expect(result.actions[1]).toMatchObject({
      domain: 'reminder',
      action: 'list',
      filter: 'tomorrow',
      scope: 'tomorrow',
    });
    expect(result.actions[2]).toMatchObject({
      domain: 'reminder',
      action: 'list',
      filter: 'tuesday',
      scope: 'tuesday',
    });
  });

  it('normalizes calendar search and list with query and scope combined', () => {
    const intent = {
      actions: [
        { domain: 'calendar', action: 'list', scope: 'tomorrow', query: 'daily' },
        { domain: 'calendar', action: 'search', scope: 'tomorrow', query: 'daily' },
      ],
    };

    const result = normalizeTurnIntentForRuntime(intent, {
      user,
      timezone: 'America/Bogota',
      referenceTime: new Date('2026-09-08T20:28:00.000Z'),
    });

    expect(result.actions[0]).toMatchObject({
      domain: 'calendar',
      action: 'list',
      scope: 'tomorrow',
      query: 'daily',
    });
    expect(result.actions[1]).toMatchObject({
      domain: 'calendar',
      action: 'search',
      scope: 'tomorrow',
      query: 'daily',
    });
  });
});
