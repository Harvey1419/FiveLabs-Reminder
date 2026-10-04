import { describe, expect, it, vi } from 'vitest';
import { TURN_INTENT_SCHEMA, validateTurnIntent, parseCanonicalOperation } from '../../../src/agent/contracts/intent-contracts.js';
import { stripStructuredNulls } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { buildDomainCall } from '../../../src/agent/orchestration/domain-call.js';
import { executeTurnIntent } from '../../../src/agent/orchestration/intent-executor.js';

const context = {
  user: { id: 'domain-field-user', timezone: 'America/Los_Angeles' },
  language: 'en',
  timezone: 'America/Los_Angeles',
  referenceTime: new Date('2026-03-07T20:00:00.000Z'),
};

describe('lossless advertised domain fields', () => {
  it('accepts canonical subscription.info and maps it without checkout', () => {
    expect(parseCanonicalOperation('subscription.info')).toEqual({ domain: 'subscription', action: 'info' });
    expect(validateTurnIntent({ actions: [{ domain: 'subscription', action: 'info' }] }).valid).toBe(true);
    expect(buildDomainCall({ domain: 'subscription', action: 'info' }, context)).toMatchObject({ valid: true, toolName: 'manage_subscription', params: { action: 'info' } });
  });
  it('keeps explicit false and deliveryPolicy.none through strict schema projection', () => {
    const action = {
      domain: 'reminder', action: 'create', content: 'Check the door',
      schedule: { kind: 'relative_day_time', dayOffset: 1, hour: 9, minute: 0, clockMode: 'explicit_24h' },
      requiresConfirmation: false,
      deliveryPolicy: { advanceNotice: 'none' },
      advanceMinutes: 15,
      recurrence: 'daily', nudgeIntervalMinutes: 12, maxNudges: 4,
    };
    expect(TURN_INTENT_SCHEMA.properties.actions.items.properties.requiresConfirmation.type).toBe('boolean');
    expect(validateTurnIntent({ actions: [action] }).valid).toBe(true);
    const projected = stripStructuredNulls({ actions: [action] });
    expect(projected.actions[0]).toMatchObject({ requiresConfirmation: false, deliveryPolicy: { advanceNotice: 'none' } });
    expect(buildDomainCall(projected.actions[0], context).params.items[0]).toMatchObject({
      requiresConfirmation: false, recurrence: 'daily', nudgeIntervalMinutes: 12, maxNudges: 4,
    });
    expect(buildDomainCall(projected.actions[0], context).params.items[0]).not.toHaveProperty('advanceMinutes');
  });

  it('preserves reminder recurrence clears and rejects unsupported update-only nudge fields', () => {
    const clearCall = buildDomainCall({
      domain: 'reminder', action: 'update', target: 'Water plants', clearFields: ['recurrence'],
      deliveryPolicy: { advanceNotice: 'none' }, advanceMinutes: 30,
    }, context);
    expect(clearCall).toMatchObject({ valid: true, params: { action: 'update', updates: { recurrence: null }, deliveryPolicy: { advanceNotice: 'none' } } });
    expect(clearCall.params).not.toHaveProperty('advanceMinutes');
    expect(validateTurnIntent({ actions: [{ domain: 'reminder', action: 'update', target: 'Water plants', clearFields: ['recurrence'] }] }).valid).toBe(true);

    const unsupported = buildDomainCall({
      domain: 'reminder', action: 'update', target: 'Water plants', nudgeIntervalMinutes: 20,
    }, context);
    expect(unsupported).toMatchObject({ valid: false, errorCode: 'UNSUPPORTED_FIELD' });
  });

  it('distinguishes append, replacement, and clear for task descriptions and due dates', () => {
    const replace = buildDomainCall({
      domain: 'task', action: 'update', target: 'Submit invoice', description: 'Use the new portal', descriptionMode: 'replace',
    }, context);
    expect(replace.params.updates).toEqual({ description: 'Use the new portal', append: false });

    const clear = buildDomainCall({
      domain: 'task', action: 'update', target: 'Submit invoice', clearFields: ['description', 'dueDate'],
    }, context);
    expect(clear.params.updates).toEqual({ description: null, append: false, dueDate: null });

    const append = buildDomainCall({ domain: 'task', action: 'update', target: 'Submit invoice', description: 'Add note' }, context);
    expect(append.params.updates).toEqual({ description: 'Add note', append: true });
  });

  it('preserves supported calendar end-only and duration updates, and rejects unsupported notification mutations', () => {
    const endOnly = buildDomainCall({
      domain: 'calendar', action: 'update', target: 'Planning',
      endSchedule: { kind: 'calendar_date_time', year: 2026, month: 3, day: 8, hour: 11, minute: 30, clockMode: 'explicit_24h' },
    }, context);
    expect(endOnly).toMatchObject({ valid: true, params: { action: 'update_event', endDateTime: expect.any(String) } });

    const allDayEndOnly = buildDomainCall({
      domain: 'calendar', action: 'update', target: 'Planning',
      endSchedule: { kind: 'calendar_date_time', allDay: true, year: 2026, month: 3, day: 8 },
    }, context);
    expect(allDayEndOnly).toMatchObject({ valid: true, params: { endDate: '2026-03-08' } });
    expect(allDayEndOnly.params).not.toHaveProperty('allDay');
    expect(buildDomainCall({
      domain: 'calendar', action: 'update', target: 'Planning',
      schedule: { kind: 'calendar_date_time', year: 2026, month: 3, day: 8, hour: 10, minute: 0, clockMode: 'explicit_24h' },
      endSchedule: { kind: 'calendar_date_time', allDay: true, year: 2026, month: 3, day: 9 },
    }, context)).toMatchObject({ valid: false, errorCode: 'INVALID_PARAMETERS' });

    const duration = buildDomainCall({ domain: 'calendar', action: 'update', target: 'Planning', durationMinutes: 90 }, context);
    expect(duration).toMatchObject({ valid: true, params: { durationMinutes: 90 } });
    expect(buildDomainCall({ domain: 'calendar', action: 'update', target: 'Planning', recurrence: 'weekly' }, context))
      .toMatchObject({ valid: true, params: { recurrence: 'weekly' } });
    expect(buildDomainCall({ domain: 'calendar', action: 'update', target: 'Planning', clearFields: ['recurrence', 'description'] }, context))
      .toMatchObject({ valid: true, params: { clearRecurrence: true, description: '' } });

    for (const field of [{ advanceMinutes: 15 }, { addGoogleMeet: true }]) {
      expect(buildDomainCall({ domain: 'calendar', action: 'update', target: 'Planning', ...field }, context))
        .toMatchObject({ valid: false, errorCode: 'UNSUPPORTED_FIELD' });
    }
  });

  it('rejects unsupported advertised fields before invoking a domain executor', async () => {
    const executeTool = vi.fn();
    const result = await executeTurnIntent({ actions: [{
      domain: 'calendar', action: 'update', target: 'Planning', addGoogleMeet: true,
    }] }, { ...context, executeTool, isPro: true });

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.records[0].result).toMatchObject({ success: false, errorCode: 'UNSUPPORTED_FIELD' });
  });

  it.each([null, {}, 42, '', '   ', 'a'.repeat(201), '*', 'a\0b'])('rejects malformed reminder query %j without execution', async query => {
    const call = buildDomainCall({ domain: 'reminder', action: 'list', query }, context);
    expect(call).toMatchObject({ valid: false, errorCode: 'INVALID_QUERY' });
    const executeTool = vi.fn();
    const result = await executeTurnIntent({ actions: [{ domain: 'reminder', action: 'list', query }] }, { ...context, executeTool, isPro: true });
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.records[0].result.errorCode).toBe('INVALID_QUERY');
  });

  it('uses explicit calendar dates and timezone calendar arithmetic for reads', () => {
    const exactDate = buildDomainCall({
      domain: 'calendar', action: 'list',
      schedule: { kind: 'calendar_date_time', year: 2026, month: 3, day: 8 },
    }, context);
    expect(exactDate.params).toMatchObject({ action: 'list_events', scope: 'explicit_date', date: '2026-03-08' });

    const taskDate = buildDomainCall({
      domain: 'task', action: 'list',
      schedule: { kind: 'relative_day_time', dayOffset: 3 },
    }, { ...context, referenceTime: new Date('2026-03-08T07:30:00.000Z') });
    expect(taskDate.params.scope).toBe('explicit_date@2026-03-10');

    const reminderDate = buildDomainCall({
      domain: 'reminder', action: 'list',
      schedule: { kind: 'calendar_date_time', year: 2026, month: 3, day: 8 },
    }, context);
    expect(reminderDate.params).toMatchObject({ filter: 'explicit_date@2026-03-08', scope: 'explicit_date@2026-03-08' });
    expect(buildDomainCall({ domain: 'reminder', action: 'list', query: ' water ' }, context))
      .toMatchObject({ valid: true, params: { action: 'list', query: 'water' } });
  });
});
