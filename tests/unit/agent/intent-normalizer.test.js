import { describe, expect, it } from 'vitest';
import { normalizeTurnIntentForRuntime } from '../../../src/agent/orchestration/intent-normalizer.js';
import { clearWorkingMemory, saveWorkingMemory } from '../../../src/agent/core/working-memory.js';

const user = { id: 'user-normalizer', phone_number: '573009999999' };
const context = {
  user,
  referenceTime: new Date('2026-12-31T23:30:00Z'),
  timezone: 'America/Bogota',
};

describe('semantic intent runtime normalization', () => {


  it('fills a missing calendar year from the user-local reference date', () => {
    const normalized = normalizeTurnIntentForRuntime({
      actions: [{
        domain: 'agenda', action: 'read',
        schedule: { kind: 'calendar_date_time', month: 12, day: 31, hour: 10, minute: 0, clockMode: 'explicit_24h' },
      }],
    }, context);

    expect(normalized.actions[0].schedule.year).toBe(2026);
  });

  it('maps a semantic newName to the concrete mutable field for each domain', () => {
    const normalized = normalizeTurnIntentForRuntime({
      actions: [
        { domain: 'reminder', action: 'update', target: 'Test Update', newName: 'cita en cerámica Italia' },
        { domain: 'task', action: 'update', target: 'la segunda', newName: 'Revisar memoria' },
        { domain: 'calendar', action: 'update', target: 'la primera', newName: 'Cita odontológica' },
      ],
    }, context);

    expect(normalized.actions[0].content).toBe('cita en cerámica Italia');
    expect(normalized.actions[1].title).toBe('Revisar memoria');
    expect(normalized.actions[2].title).toBe('Cita odontológica');
  });

  it('anchors an elapsed daily reminder clock at the next future occurrence', () => {
    const eveningContext = {
      user,
      referenceTime: new Date('2026-09-07T23:30:00.000Z'), // 6:30 PM Bogota
      timezone: 'America/Bogota',
    };
    const normalized = normalizeTurnIntentForRuntime({
      actions: [{
        domain: 'reminder',
        action: 'create',
        content: 'Hacer Duolingo',
        recurrence: 'daily',
        schedule: { kind: 'local_time', hour: 9, minute: 0, clockMode: 'explicit_am' },
      }],
    }, eveningContext);

    expect(normalized.actions[0].recurrence).toBe('daily');
    expect(normalized.actions[0].schedule).toMatchObject({
      kind: 'relative_day_time',
      dayOffset: 1,
      hour: 9,
      minute: 0,
    });
  });

  it('keeps a future daily reminder clock on the current local day', () => {
    const morningContext = {
      user,
      referenceTime: new Date('2026-09-07T12:00:00.000Z'), // 7:00 AM Bogota
      timezone: 'America/Bogota',
    };
    const normalized = normalizeTurnIntentForRuntime({
      actions: [{
        domain: 'reminder',
        action: 'create',
        content: 'Hacer Duolingo',
        recurrence: 'daily',
        schedule: { kind: 'local_time', hour: 9, minute: 0, clockMode: 'explicit_am' },
      }],
    }, morningContext);

    expect(normalized.actions[0].recurrence).toBe('daily');
    expect(normalized.actions[0].schedule.kind).toBe('local_time');
  });

  it('keeps partial calendar updates as pure semantic deltas without inheriting stale title/time', () => {
    saveWorkingMemory(user, {
      source: 'calendar',
      scope: 'today',
      entityType: 'calendar_event',
      items: [{
        position: 1,
        type: 'calendar_event',
        internalId: 'google-event-1',
        summary: 'Reunión de equipo',
        time: '2026-09-08T15:00:00.000Z',
        raw: { summary: 'Reunión de equipo', startDateTime: '2026-09-08T15:00:00.000Z' },
      }],
    });

    const normalized = normalizeTurnIntentForRuntime({
      actions: [{ domain: 'calendar', action: 'update', target: 'la primera', description: 'Llevar avances' }],
    }, context);

    expect(normalized.actions[0]).toMatchObject({
      domain: 'calendar',
      action: 'update',
      target: 'la primera',
      description: 'Llevar avances',
    });
    expect(normalized.actions[0]).not.toHaveProperty('title');
    expect(normalized.actions[0]).not.toHaveProperty('schedule');
    clearWorkingMemory(user);
  });
});
