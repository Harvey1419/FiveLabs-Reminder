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
  it('moves a daily recurring update to tomorrow when today clock time already passed', () => {
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
      referenceTime: new Date('2026-09-08T00:04:00.000Z'), // 19:04 previous local day? explicit test reference below
    });

    // 2026-09-07 19:04 Bogota -> 08:00 for that local day has already passed.
    expect(result.actions[0].schedule).toMatchObject({
      kind: 'relative_day_time',
      dayOffset: 1,
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
      referenceTime: new Date('2026-09-07T12:00:00.000Z'), // 07:00 Bogota
    });

    expect(result.actions[0].schedule).toMatchObject({ kind: 'local_time', hour: 8, minute: 0 });
  });
});
