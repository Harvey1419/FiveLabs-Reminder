import { describe, expect, it } from 'vitest';
import { TURN_INTENT_SCHEMA, validateTurnIntent } from '../../../src/agent/contracts/intent-contracts.js';
import { getStructuredTurnSchema, stripStructuredNulls } from '../../../src/agent/contracts/foreground-turn-schema.js';
import { resolveTypedSchedule } from '../../../src/agent/orchestration/typed-schedule.js';

// Groq rejected polymorphic action/schedule unions at compile time and generated
// invalid values from accepted nested unions. Nullable types need no object union.
function inspectProjection(node) {
  expect(node).not.toHaveProperty('anyOf');
  if (node.properties) {
    expect(node.additionalProperties).toBe(false);
    expect(node.required).toEqual(Object.keys(node.properties));
    Object.values(node.properties).forEach(inspectProjection);
  }
  expect(node).not.toHaveProperty('uniqueItems');
  if (node.items) inspectProjection(node.items);
}

describe('Groq strict provider projection regressions', () => {
  it.each([
    { isAdmin: false, attachmentOnly: false },
    { isAdmin: true, attachmentOnly: false },
    { isAdmin: false, attachmentOnly: true },
    { isAdmin: true, attachmentOnly: true },
  ])('uses a closed canonical shape with nullable types and no polymorphic unions: %j', (options) => {
    const before = structuredClone(TURN_INTENT_SCHEMA);
    const schema = getStructuredTurnSchema(options);
    inspectProjection(schema);
    expect(schema.properties.actions.maxItems).toBe(12);
    const domains = schema.properties.actions.items.properties.domain.enum;
    expect(domains).toEqual(options.attachmentOnly ? ['conversation'] : before.properties.actions.items.properties.domain.enum.filter((domain) => options.isAdmin || domain !== 'admin'));
    expect(TURN_INTENT_SCHEMA).toEqual(before);
  });

  it('preserves every optional scalar constraint and removes null without changing false or zero', () => {
    const action = getStructuredTurnSchema().properties.actions.items;
    expect(action.properties.priority).toEqual({ type: ['string', 'null'], enum: [...TURN_INTENT_SCHEMA.properties.actions.items.properties.priority.enum, null] });
    expect(action.properties.advanceMinutes).toEqual({ type: ['integer', 'null'], minimum: 1, maximum: 10080 });
    expect(stripStructuredNulls({ requiresConfirmation: false, schedule: { dayOffset: 0, minute: 0, offsetMinutes: null } }))
      .toEqual({ requiresConfirmation: false, schedule: { dayOffset: 0, minute: 0 } });
  });

  it.each([null, undefined, {}, { kind: 'inherit_context' }, { kind: 'unknown' }])('keeps incomplete creation non-executable after nullable adaptation: %j', (schedule) => {
    const intent = stripStructuredNulls({ actions: [{ domain: 'reminder', action: 'create', content: 'Alfa', schedule }] });
    const validation = validateTurnIntent(intent);
    expect(validation).toMatchObject({ valid: false, errorCode: 'MISSING_SCHEDULE' });
    expect(validation).not.toHaveProperty('intent');
  });

  it.each(['relative_day_time', 'calendar_date_time', 'weekday_time', 'local_time'])('documents clock encoding without changing deterministic range checks: %s', (kind) => {
    const schedule = getStructuredTurnSchema().properties.actions.items.properties.schedule;
    expect(schedule.properties.clockMode.enum).toEqual([...TURN_INTENT_SCHEMA.properties.actions.items.properties.schedule.properties.clockMode.enum, null]);
    expect(schedule.properties.clockMode.description).toContain('Never pair explicit_pm with hour 13..23');
    expect(schedule.properties.hour).toEqual({ type: ['integer', 'null'], minimum: 0, maximum: 23 });
    expect(schedule.properties.minute.type).toEqual(['integer', 'null']);
    const base = { kind, dayOffset: 1, year: 2026, month: 9, day: 10, weekday: 'thursday' };
    const context = { referenceTime: new Date('2026-09-09T23:00:00Z'), timezone: 'America/Bogota' };
    expect(resolveTypedSchedule({ ...base, hour: 15, clockMode: 'explicit_pm' }, context).errorCode).toBe('INVALID_12H_CLOCK');
    expect(resolveTypedSchedule({ ...base, hour: 3, clockMode: 'explicit_pm' }, context).valid).toBe(true);
    expect(resolveTypedSchedule({ ...base, hour: 15, clockMode: 'explicit_24h' }, context).valid).toBe(true);
  });

  it('retains canonical missingFields uniqueness after provider projection', () => {
    expect(TURN_INTENT_SCHEMA.properties.actions.items.properties.missingFields.uniqueItems).toBe(true);
    expect(validateTurnIntent({ actions: [{ domain: 'clarification', action: 'request', missingFields: ['main_time', 'main_time'] }] }).valid).toBe(false);
    expect(TURN_INTENT_SCHEMA.properties.actions.items.required).toEqual(['domain', 'action']);
  });
});
