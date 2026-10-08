import { describe, expect, it } from 'vitest';
import {
  TURN_INTENT_SCHEMA,
  EXECUTE_TURN_DESCRIPTION,
  getConversationToolDefinition,
  getCanonicalOperations,
  validateTurnIntent,
} from '../../../src/agent/contracts/intent-contracts.js';
import {
  getStructuredTurnSchema,
  projectStructuredTurnIntent,
  stripStructuredNulls,
} from '../../../src/agent/contracts/foreground-turn-schema.js';
import { resolveTypedSchedule } from '../../../src/agent/orchestration/typed-schedule.js';
import { buildAgentCorePrompt } from '../../../src/agent/core/agent-core.js';

// Groq rejected polymorphic action/schedule unions at compile time and generated
// invalid values from accepted nested unions. Nullable types need no object union.
function inspectProjection(node) {
  expect(node).not.toHaveProperty('anyOf');
  expect(node).not.toHaveProperty('oneOf');
  expect(node).not.toHaveProperty('$ref');
  if (node.properties) {
    expect(node.additionalProperties).toBe(false);
    expect(node.required).toEqual(Object.keys(node.properties));
    Object.values(node.properties).forEach(inspectProjection);
  }
  expect(node).not.toHaveProperty('uniqueItems');
  if (node.items) inspectProjection(node.items);
}

describe('Groq strict provider projection regressions', () => {
  it('states strict wire obligations without treating nullable fields as semantic permission', () => {
    const prompt = buildAgentCorePrompt({ timezone: 'America/Bogota' });
    for (const options of [{}, { isAdmin: true }, { attachmentOnly: true }, { isAdmin: true, attachmentOnly: true }]) {
      const description = getStructuredTurnSchema(options).description;
      for (const text of [description, prompt]) {
        expect(text).toContain('Emit every property');
        expect(text).toContain('inapplicable nullable fields must be null');
        expect(text).toContain('learningCandidates=[]');
        expect(text).toContain('semantic prerequisites');
      }
    }
  });

  it('shares payment and recap guidance across both decision descriptions', () => {
    const conversation = getConversationToolDefinition().function.description;
    expect(EXECUTE_TURN_DESCRIPTION).toContain('LECTURAS:');
    const shared = EXECUTE_TURN_DESCRIPTION.slice(EXECUTE_TURN_DESCRIPTION.indexOf('LECTURAS:'));
    expect(conversation).toContain(shared);
    for (const rule of ['scope="plan"', 'Free-only existing Stripe', 'No model-authored URL',
      'unscoped subscription.info', 'conversation.reply alone is not billing authority',
      'general + subscription.link', 'actions must never be empty', 'How-to alone stays side-effect-free',
      'tool-backed provider capability', 'NO subscription.link or mutation',
      'Unknown payment outcome never authorizes retry', 'no checkout to discover capabilities',
      'historical renders recorded facts', 'Current: explicit reads, not history', 'Solo recap refs normalize to partial history']) {
      expect(shared).toContain(rule);
    }
  });

  it.each([
    { responseLanguage: null }, { responseCapability: null }, { learningCandidates: null },
  ])('does not turn required semantic fields into nullable permissions: %j', fields => {
    const intent = projectStructuredTurnIntent(stripStructuredNulls({
      responseLanguage: 'en', responseCapability: 'general', learningCandidates: [],
      actions: [{ operation: 'conversation.reply', content: 'Hello' }], ...fields,
    }));
    // Language has a runtime fallback; capability and candidate-array authority
    // must still be valid when required by the foreground boundary.
    const validation = validateTurnIntent(intent, { requireResponseCapability: true });
    if (Object.hasOwn(fields, 'responseLanguage')) {
      expect(getStructuredTurnSchema().properties.responseLanguage.type).toBe('string');
      expect(validation.valid).toBe(true);
    } else {
      expect(validation.valid).toBe(false);
    }
  });
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
    const action = schema.properties.actions.items;
    const domains = options.attachmentOnly
      ? ['conversation']
      : before.properties.actions.items.properties.domain.enum.filter((domain) => options.isAdmin || domain !== 'admin');
    expect(action.properties).not.toHaveProperty('domain');
    expect(action.properties).not.toHaveProperty('action');
    expect(action.properties.operation.enum).toEqual(options.attachmentOnly ? ['conversation.reply'] : getCanonicalOperations({ domains }));
    expect(schema.properties.responseLanguage.type).toBe('string');
    expect(schema.properties.responseCapability.type).toBe('string');
    expect(schema.properties.responseCapability.enum).toEqual(options.attachmentOnly ? ['general'] : ['general', 'billing_info']);
    if (!options.attachmentOnly) expect(action.properties.operation.enum).toContain('reminder.list');
    expect(action.properties.operation.enum).not.toContain('reminder.search');
    expect(TURN_INTENT_SCHEMA).toEqual(before);
  });

  it('projects one qualified provider operation to one canonical domain/action pair', () => {
    const providerIntent = { actions: [{ operation: 'reminder.list', scope: 'today' }] };
    expect(projectStructuredTurnIntent(providerIntent)).toEqual({
      actions: [{ domain: 'reminder', action: 'list', scope: 'today' }],
    });
    expect(validateTurnIntent(projectStructuredTurnIntent(providerIntent))).toMatchObject({ valid: true });
  });

  it('does not expose legacy pendingIntentEffect in the schema', () => {
    const schema = getStructuredTurnSchema();
    expect(schema.properties).not.toHaveProperty('pendingIntentEffect');
    expect(schema.required).not.toContain('pendingIntentEffect');
    expect(TURN_INTENT_SCHEMA.properties).not.toHaveProperty('pendingIntentEffect');
  });

  it('does not reinterpret unknown qualified operations', () => {
    const projected = projectStructuredTurnIntent({ actions: [{ operation: 'reminder.search', scope: 'today' }] });
    expect(validateTurnIntent(projected)).toMatchObject({ valid: false, errorCode: 'UNSUPPORTED_ACTION' });
  });

  it('preserves every optional scalar constraint and removes null without changing false or zero', () => {
    const action = getStructuredTurnSchema().properties.actions.items;
    expect(action.properties.priority).toEqual({ type: ['string', 'null'], enum: [...TURN_INTENT_SCHEMA.properties.actions.items.properties.priority.enum, null] });
    expect(action.properties.advanceMinutes).toEqual({
      type: ['integer', 'null'],
      minimum: 1,
      maximum: 10080,
      ...(TURN_INTENT_SCHEMA.properties.actions.items.properties.advanceMinutes.description
        ? { description: TURN_INTENT_SCHEMA.properties.actions.items.properties.advanceMinutes.description }
        : {}),
    });
    expect(stripStructuredNulls({ requiresConfirmation: false, schedule: { dayOffset: 0, minute: 0, offsetMinutes: null } }))
      .toEqual({ requiresConfirmation: false, schedule: { dayOffset: 0, minute: 0 } });
  });

  it.each([null, undefined, {}, { kind: 'inherit_context' }, { kind: 'unknown' }])('keeps incomplete creation non-executable after nullable adaptation: %j', (schedule) => {
    const intent = stripStructuredNulls({ actions: [{ domain: 'reminder', action: 'create', content: 'Alfa', schedule }] });
    const validation = validateTurnIntent(intent);
    expect(validation).toMatchObject({ valid: false, errorCode: 'MISSING_SCHEDULE' });
    expect(validation).not.toHaveProperty('intent');
  });

  it.each([
    [{ kind: 'relative_day_time', dayOffset: 1 }, ['time']],
    [{ kind: 'local_time', hour: 9, minute: 0, clockMode: 'explicit_24h' }, ['date']],
  ])('keeps a typed partial schedule canonical while marking its structural execution blocker: %j', (schedule, missingFields) => {
    const providerIntent = stripStructuredNulls({
      actions: [{
        operation: 'reminder.create',
        content: 'Pagar factura',
        schedule,
        missingFields: null,
      }],
    });

    const validation = validateTurnIntent(projectStructuredTurnIntent(providerIntent));

    expect(validation).toMatchObject({
      valid: true,
      intent: {
        actions: [{
          domain: 'reminder',
          action: 'create',
          schedule,
          missingFields,
        }],
      },
    });
  });

  it('rejects pending metadata that omits the actual structural schedule blocker', () => {
    const validation = validateTurnIntent({ actions: [{
      domain: 'reminder', action: 'create', content: 'Pagar factura',
      schedule: { kind: 'relative_day_time', dayOffset: 1 },
      missingFields: ['date'],
    }] });

    expect(validation).toMatchObject({ valid: false, errorCode: 'MISSING_SCHEDULE' });
  });

  it.each(['relative_day_time', 'calendar_date_time', 'weekday_time', 'local_time'])('documents clock encoding without changing deterministic range checks: %s', (kind) => {
    const schedule = getStructuredTurnSchema().properties.actions.items.properties.schedule;
    expect(schedule.properties.clockMode.enum).toEqual(['explicit_24h', 'ambiguous_12h', null]);
    expect(TURN_INTENT_SCHEMA.properties.actions.items.properties.schedule.properties.clockMode.enum).toEqual(['explicit_24h', 'explicit_am', 'explicit_pm', 'ambiguous_12h']);
    expect(schedule.properties.clockMode.description).toContain('3 PM = 15');
    expect(schedule.properties.clockMode.description).toContain('Do not invent AM/PM');
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
